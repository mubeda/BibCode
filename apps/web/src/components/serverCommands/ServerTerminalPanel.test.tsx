// @vitest-environment happy-dom
import { EnvironmentId, TerminalInputError } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  phase: "connected",
  queries: [] as unknown[],
  query: { data: null as unknown, error: null as string | null, isPending: false },
  terminals: [] as Array<Record<string, unknown>>,
  mounts: 0,
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  navigate: vi.fn(),
  canGoBack: true,
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  useCanGoBack: () => h.canGoBack,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ keybindings: [] }) }));
vi.mock("~/state/environments", () => ({
  useEnvironment: (environmentId: string) => ({
    environmentId,
    label: "Server A",
    entry: { target: { _tag: "BearerConnectionTarget", connectionId: environmentId } },
    connection: { phase: h.phase, error: null, traceId: null },
    // A server that offers every terminal capability, including the process-checked close an
    // earlier version of this panel sent on exit.
    serverConfig: { environment: { capabilities: { serverTerminal: true } } },
  }),
}));
vi.mock("~/state/filesystem", () => ({
  filesystemEnvironment: { browse: (request: unknown) => ({ browse: request }) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    h.queries.push(atom);
    return {
      data: atom === null ? null : h.query.data,
      error: atom === null ? null : h.query.error,
      isPending: atom !== null && h.query.isPending,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("~/state/terminal", () => ({ terminalEnvironment: { open: "open", close: "close" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: string) => (atom === "open" ? h.openTerminal : h.closeTerminal),
}));
vi.mock("../CenterTerminalPanel", async () => {
  const { useEffect } = await import("react");
  return {
    CenterTerminalPanel: (props: Record<string, unknown>) => {
      h.terminals.push(props);
      useEffect(() => {
        h.mounts += 1;
      }, []);
      return <div data-testid="center-terminal" />;
    },
  };
});
vi.mock("../ThreadTerminalPanel", () => ({ releaseTerminalUiResources: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: h.toast } }));
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { ServerTerminalPanel } from "./ServerTerminalPanel";

const SERVER_A = EnvironmentId.make("server-a");
const HOME = "/home/test-user";
const SUCCESS = { _tag: "Success", value: {} };

let root: Root;
let container: HTMLDivElement;
const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);

beforeEach(() => {
  h.phase = "connected";
  h.queries = [];
  h.query = { data: null, error: null, isPending: true };
  h.terminals = [];
  h.mounts = 0;
  h.openTerminal.mockReset();
  h.openTerminal.mockResolvedValue(SUCCESS);
  h.closeTerminal.mockReset();
  h.closeTerminal.mockResolvedValue(SUCCESS);
  h.navigate.mockReset();
  h.canGoBack = true;
  h.toast.mockReset();
  back.mockClear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(invocation: number | undefined = 1) {
  await act(async () =>
    root.render(<ServerTerminalPanel environmentId={SERVER_A} invocation={invocation} />),
  );
}

const withHome = () => {
  h.query = { data: { directoryPath: HOME, entries: [] }, error: null, isPending: false };
};
const lastTerminal = () => h.terminals.at(-1);

describe("ServerTerminalPanel", () => {
  it("opens the server's shell in its home folder, then shows and focuses it", async () => {
    await render();
    expect(h.queries.at(-1)).toEqual({
      browse: { environmentId: SERVER_A, input: { partialPath: "~", mode: "directory" } },
    });
    expect(h.openTerminal, "no open before the home is known").not.toHaveBeenCalled();
    expect(container.textContent).toContain("Opening terminal");

    withHome();
    await render();
    expect(h.openTerminal).toHaveBeenCalledExactlyOnceWith({
      environmentId: SERVER_A,
      input: {
        threadId: "server-terminal",
        terminalId: "server-terminal",
        cwd: HOME,
        worktreePath: null,
        env: {},
        centerPanel: true,
      },
    });
    const terminal = lastTerminal();
    expect(terminal?.threadRef).toEqual({ environmentId: SERVER_A, threadId: "server-terminal" });
    expect(terminal?.launchContext).toEqual({ cwd: HOME, worktreePath: null, runtimeEnv: {} });
    expect(terminal?.focusRequestId).toBe(1);
    expect(terminal?.chatThread, "no chat owns it: no Add to chat, threadless links").toBe(false);
    expect(container.querySelector("h1")?.textContent).toBe("Server A");
  });

  it("opens again and refocuses on each invocation, keeping the mounted terminal", async () => {
    withHome();
    await render(1);
    await render(2);
    expect(h.openTerminal).toHaveBeenCalledTimes(2);
    expect(lastTerminal()?.focusRequestId).toBe(2);
    expect(h.mounts, "the terminal and its attachment stay").toBe(1);
  });

  it("keeps a running terminal where it started when the home query refetches", async () => {
    withHome();
    await render();
    h.query = { data: null, error: null, isPending: true };
    await render();
    expect(lastTerminal()?.launchContext).toEqual({
      cwd: HOME,
      worktreePath: null,
      runtimeEnv: {},
    });
    expect(h.openTerminal).toHaveBeenCalledTimes(1);
  });

  it("says why in a toast and returns to the previous view when the home cannot be read", async () => {
    h.query = { data: null, error: "Permission denied.", isPending: false };
    await render();
    expect(lastTerminal()).toBeUndefined();
    expect(h.openTerminal).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not open terminal",
        description: expect.stringContaining("Permission denied."),
      }),
    );
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("says why and leaves when the server does not start the shell", async () => {
    withHome();
    h.canGoBack = false;
    h.openTerminal.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Spawn failed."))));
    await render();
    expect(lastTerminal()).toBeUndefined();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not open terminal", description: "Spawn failed." }),
    );
    expect(h.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("says so when an older server answers without its home folder", async () => {
    h.query = { data: { entries: [] }, error: null, isPending: false };
    await render();
    expect(lastTerminal()).toBeUndefined();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("does not report its home folder"),
      }),
    );
  });

  it("sends nothing to a server that is not connected and says why", async () => {
    h.phase = "disconnected";
    await render();
    expect(h.queries.every((query) => query === null)).toBe(true);
    expect(h.openTerminal).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Server A is not connected.");
  });

  it("leaves when the shell exits and closes nothing: only an open replaces it", async () => {
    withHome();
    await render();
    // The viewport reports the exit; a caller may still name the process that exited.
    const exitedProcess = { boot: "boot-1", process: 3 };
    await act(async () => (lastTerminal()!.onClose as (process?: unknown) => void)(exitedProcess));
    expect(
      h.closeTerminal,
      "a client close can kill a shell reopened meanwhile",
    ).not.toHaveBeenCalled();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("only attaches to the shell terminal.open confirmed, never starts one", async () => {
    withHome();
    await render();
    expect(lastTerminal()?.attachOnly).toBe(true);
  });

  it("says the connection dropped and leaves when the open is interrupted, then opens again", async () => {
    withHome();
    h.openTerminal.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await render(1);
    expect(lastTerminal()).toBeUndefined();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not open terminal",
        description: expect.stringContaining("connection to Server A was lost"),
      }),
    );
    expect(back).toHaveBeenCalledTimes(1);

    // Leaving unmounts the route; Open terminal after the reconnect mounts it again.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(2);
    expect(h.openTerminal).toHaveBeenCalledTimes(2);
    expect(lastTerminal()?.focusRequestId).toBe(2);
  });

  it("shows the started shell when only its input setup failed", async () => {
    withHome();
    h.openTerminal.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new TerminalInputError({ code: "closed", message: "Terminal input timed out." }),
        ),
      ),
    );
    await render();
    expect(h.toast).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(lastTerminal()?.focusRequestId, "the terminal attaches and prepares input").toBe(1);
  });
});
