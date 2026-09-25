// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RemoteUpdateSnapshot } from "@bibcode/contracts";
import {
  IDLE_REMOTE_UPDATE_CHECK_STATE,
  type RemoteUpdateCheckState,
} from "@bibcode/client-runtime/state/remoteUpdates";
import { EnvironmentRpcUnavailableError } from "@bibcode/client-runtime/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";

// Render tooltip content inline so the reason is observable without hover and portals.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children?: ReactNode }) => (
    <span data-testid="tooltip">{children}</span>
  ),
}));

import {
  ServerUpdateBadge,
  type ServerUpdateStatus,
  describeUpdateCheckFailure,
  manualUpdateInstructions,
  serverUpdateBadgeVariant,
  serverUpdateStatusFromQuery,
} from "./ServerUpdateBadge";

const manualSnapshot: RemoteUpdateSnapshot = {
  serverVersion: "0.4.2",
  latestVersion: null,
  state: "idle",
  error: null,
  support: { installMode: "manual", reason: "manual-update-required" },
};

const interactiveSnapshot: RemoteUpdateSnapshot = {
  ...manualSnapshot,
  latestVersion: "0.5.0",
  state: "update-available",
  support: { installMode: "interactive", reason: "available" },
};

const idleInteractiveSnapshot: RemoteUpdateSnapshot = {
  ...interactiveSnapshot,
  latestVersion: null,
  state: "idle",
};

const upToDateSnapshot: RemoteUpdateSnapshot = {
  ...interactiveSnapshot,
  latestVersion: null,
  state: "up-to-date",
};

const QUIET: Omit<ServerUpdateStatus, "snapshot"> = {
  pending: false,
  error: null,
  checking: false,
  checkError: null,
};

function settled(snapshot: RemoteUpdateSnapshot): ServerUpdateStatus {
  return { ...QUIET, snapshot };
}

function status(overrides: Partial<ServerUpdateStatus>): ServerUpdateStatus {
  return { ...QUIET, snapshot: null, ...overrides };
}

const LOST_SOCKET = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({
    message: "socket closed",
    cause: new Error("socket closed"),
  }),
});
const NO_SESSION = new EnvironmentRpcUnavailableError({
  environmentId: "env-remote",
  message: "AI-SERVER is not connected.",
});

function failedRead(error: unknown, data: RemoteUpdateSnapshot | null = null) {
  return {
    data,
    emission: AsyncResult.failure<RemoteUpdateSnapshot, unknown>(Cause.fail(error)),
    error: error instanceof Error ? error.message : "The environment request failed.",
    isPending: false,
  };
}

const connected = (check: RemoteUpdateCheckState = IDLE_REMOTE_UPDATE_CHECK_STATE) => ({
  connected: true,
  check,
});

const mountedRoots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return container;
}

describe("serverUpdateBadgeVariant", () => {
  it("maps settled snapshots onto badge variants", () => {
    expect(serverUpdateBadgeVariant(settled(manualSnapshot))).toBe("manual");
    expect(serverUpdateBadgeVariant(settled(upToDateSnapshot))).toBe("up-to-date");
    expect(serverUpdateBadgeVariant(settled(interactiveSnapshot))).toBe("update-available");
    expect(
      serverUpdateBadgeVariant(settled({ ...interactiveSnapshot, state: "error", error: "boom" })),
    ).toBe("error");
  });

  it("shows the host checking its feed as checking, and downloads and installs as busy", () => {
    expect(serverUpdateBadgeVariant(settled({ ...interactiveSnapshot, state: "checking" }))).toBe(
      "checking",
    );
    expect(
      serverUpdateBadgeVariant(settled({ ...interactiveSnapshot, state: "downloading" })),
    ).toBe("busy");
    expect(serverUpdateBadgeVariant(settled({ ...interactiveSnapshot, state: "installing" }))).toBe(
      "busy",
    );
  });

  it("says an automatic host has not checked yet, and keeps manual hosts manual", () => {
    expect(serverUpdateBadgeVariant(settled(idleInteractiveSnapshot))).toBe("not-checked");
    expect(
      serverUpdateBadgeVariant(
        settled({
          ...idleInteractiveSnapshot,
          support: { installMode: "supervised", reason: "available" },
        }),
      ),
    ).toBe("not-checked");
    expect(serverUpdateBadgeVariant(settled(manualSnapshot))).toBe("manual");
  });

  it("tells a pending first read apart from a failed read", () => {
    expect(serverUpdateBadgeVariant(status({ pending: true }))).toBe("checking");
    expect(serverUpdateBadgeVariant(status({ error: "offline" }))).toBe("unreachable");
  });

  it("lets a failed read win over the last snapshot until a retry settles", () => {
    expect(serverUpdateBadgeVariant(status({ snapshot: upToDateSnapshot, error: "offline" }))).toBe(
      "unreachable",
    );
    expect(
      serverUpdateBadgeVariant(
        status({ snapshot: upToDateSnapshot, error: "offline", pending: true }),
      ),
    ).toBe("checking");
  });

  it("keeps showing a known snapshot during a background re-read", () => {
    expect(serverUpdateBadgeVariant(status({ snapshot: upToDateSnapshot, pending: true }))).toBe(
      "up-to-date",
    );
  });

  it("shows a failed check as its own state, apart from an unreachable updater", () => {
    const checkError = "The update check timed out after 30 seconds.";
    expect(serverUpdateBadgeVariant(status({ snapshot: upToDateSnapshot, checkError }))).toBe(
      "check-failed",
    );
    expect(serverUpdateBadgeVariant(status({ checkError }))).toBe("check-failed");
    expect(
      serverUpdateBadgeVariant(status({ snapshot: upToDateSnapshot, checkError, error: "down" })),
    ).toBe("unreachable");
  });

  it("lets the host's own activity outrank an earlier failed check", () => {
    const checkError = "The update check timed out after 30 seconds.";
    expect(
      serverUpdateBadgeVariant(
        status({ snapshot: { ...interactiveSnapshot, state: "checking" }, checkError }),
      ),
    ).toBe("checking");
    expect(
      serverUpdateBadgeVariant(
        status({ snapshot: { ...interactiveSnapshot, state: "installing" }, checkError }),
      ),
    ).toBe("busy");
  });

  it("shows a running check as checking, whichever view started it", () => {
    expect(
      serverUpdateBadgeVariant(
        status({ snapshot: upToDateSnapshot, checking: true, checkError: "earlier failure" }),
      ),
    ).toBe("checking");
  });

  it("has nothing to show before any read has run", () => {
    expect(serverUpdateBadgeVariant(status({}))).toBeNull();
  });
});

describe("serverUpdateStatusFromQuery", () => {
  it("passes a read that failed over a live connection through", () => {
    const view = serverUpdateStatusFromQuery(
      failedRead(new Error("Desktop updater did not answer.")),
      connected(),
    );
    expect(view).toEqual(status({ error: "Desktop updater did not answer." }));
    expect(serverUpdateBadgeVariant(view)).toBe("unreachable");
  });

  it("keeps the last snapshot when a read only lost its connection", () => {
    for (const lost of [NO_SESSION, LOST_SOCKET]) {
      const view = serverUpdateStatusFromQuery(failedRead(lost, upToDateSnapshot), connected());
      expect(view.error).toBeNull();
      expect(serverUpdateBadgeVariant(view)).toBe("up-to-date");
    }
    expect(
      serverUpdateBadgeVariant(serverUpdateStatusFromQuery(failedRead(NO_SESSION), connected())),
    ).toBeNull();
  });

  it("does not claim a check or an updater failure while the environment is offline", () => {
    const neverLoaded = serverUpdateStatusFromQuery(
      { data: null, emission: AsyncResult.initial(true), error: null, isPending: true },
      { connected: false, check: IDLE_REMOTE_UPDATE_CHECK_STATE },
    );
    expect(serverUpdateBadgeVariant(neverLoaded)).toBeNull();

    const failed = serverUpdateStatusFromQuery(failedRead(new Error("boom"), upToDateSnapshot), {
      connected: false,
      check: IDLE_REMOTE_UPDATE_CHECK_STATE,
    });
    expect(failed.error).toBeNull();
    expect(serverUpdateBadgeVariant(failed)).toBe("up-to-date");
  });

  it("carries the shared check state: a running check and a failed check's reason", () => {
    const running = serverUpdateStatusFromQuery(
      {
        data: upToDateSnapshot,
        emission: AsyncResult.success(upToDateSnapshot),
        error: null,
        isPending: false,
      },
      connected({ inFlight: true, failure: null }),
    );
    expect(running.checking).toBe(true);

    const failed = serverUpdateStatusFromQuery(
      {
        data: upToDateSnapshot,
        emission: AsyncResult.success(upToDateSnapshot),
        error: null,
        isPending: false,
      },
      connected({
        inFlight: false,
        failure: { cause: Cause.fail(new Error("feed timed out")), generation: 3 },
      }),
    );
    expect(failed.checkError).toBe("feed timed out");
    expect(serverUpdateBadgeVariant(failed)).toBe("check-failed");
  });
});

describe("describeUpdateCheckFailure", () => {
  it("names a timeout, passes an error's message, and falls back when there is none", () => {
    expect(describeUpdateCheckFailure(Cause.fail(new Cause.TimeoutError()))).toBe(
      "The update check timed out after 30 seconds.",
    );
    expect(describeUpdateCheckFailure(Cause.fail(new Error("feed returned 502")))).toBe(
      "feed returned 502",
    );
    expect(describeUpdateCheckFailure(Cause.fail("opaque"))).toBe("The update check failed.");
  });
});

describe("ServerUpdateBadge", () => {
  it("names the available version when known", () => {
    const markup = renderToStaticMarkup(<ServerUpdateBadge {...settled(interactiveSnapshot)} />);
    expect(markup).toContain("0.5.0");
    expect(markup).toContain('data-variant="update-available"');
  });

  it("labels manual servers without claiming update knowledge", () => {
    const markup = renderToStaticMarkup(<ServerUpdateBadge {...settled(manualSnapshot)} />);
    expect(markup).toContain("Manual updates");
  });

  it("labels each status the user can be in", () => {
    const labelFor = (value: ServerUpdateStatus) =>
      mount(<ServerUpdateBadge {...value} />).textContent;
    expect(labelFor(settled(idleInteractiveSnapshot))).toBe("Not checked yet");
    expect(labelFor(status({ pending: true }))).toBe("Checking…");
    expect(labelFor(settled({ ...interactiveSnapshot, state: "checking" }))).toBe("Checking…");
    expect(labelFor(settled({ ...interactiveSnapshot, state: "installing" }))).toBe("Updating…");
    expect(labelFor(settled(upToDateSnapshot))).toBe("Up to date");
  });

  it("explains an unreachable updater in a tooltip and re-reads on Retry", () => {
    const onRetry = vi.fn();
    const onCheckAgain = vi.fn();
    const container = mount(
      <ServerUpdateBadge
        {...status({ error: "Desktop updater did not answer." })}
        onRetry={onRetry}
        onCheckAgain={onCheckAgain}
      />,
    );
    const badge = container.querySelector('[data-variant="unreachable"]');
    expect(badge?.textContent).toContain("Can't reach updater");
    expect(badge?.getAttribute("title")).toBeNull();
    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe(
      "Desktop updater did not answer.",
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Retry"]);
    act(() => buttons[0]?.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onCheckAgain).not.toHaveBeenCalled();
  });

  it("shows a failed check with its reason and checks again on request", () => {
    const onRetry = vi.fn();
    const onCheckAgain = vi.fn();
    const container = mount(
      <ServerUpdateBadge
        {...status({ snapshot: upToDateSnapshot, checkError: "feed timed out" })}
        onRetry={onRetry}
        onCheckAgain={onCheckAgain}
      />,
    );
    expect(container.querySelector('[data-variant="check-failed"]')?.textContent).toContain(
      "Check failed",
    );
    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe("feed timed out");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Check again"]);
    act(() => buttons[0]?.click());
    expect(onCheckAgain).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("gives an update error its host message and the same next step", () => {
    const onCheckAgain = vi.fn();
    const container = mount(
      <ServerUpdateBadge
        {...settled({ ...interactiveSnapshot, state: "error", error: "Signature mismatch" })}
        onCheckAgain={onCheckAgain}
      />,
    );
    expect(container.querySelector('[data-variant="error"]')?.getAttribute("title")).toBeNull();
    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe(
      "Signature mismatch",
    );
    act(() => container.querySelector("button")?.click());
    expect(onCheckAgain).toHaveBeenCalledOnce();
  });

  it("offers no action where the caller has one of its own", () => {
    const container = mount(
      <ServerUpdateBadge {...status({ snapshot: upToDateSnapshot, checkError: "timed out" })} />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe("timed out");
  });

  it("offers no action for settled states", () => {
    const container = mount(
      <ServerUpdateBadge
        {...settled(upToDateSnapshot)}
        onRetry={() => undefined}
        onCheckAgain={() => undefined}
      />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="tooltip"]')).toBeNull();
  });

  it("renders nothing when there is nothing to show", () => {
    expect(renderToStaticMarkup(<ServerUpdateBadge {...status({})} />)).toBe("");
  });

  it("keeps badge text at the 12 px floor in the solid secondary color", () => {
    const statuses: ServerUpdateStatus[] = [
      settled(idleInteractiveSnapshot),
      settled(manualSnapshot),
      settled(upToDateSnapshot),
      status({ pending: true }),
      status({ checkError: "timed out" }),
    ];
    for (const value of statuses) {
      const markup = renderToStaticMarkup(<ServerUpdateBadge {...value} />);
      expect(markup).toContain("text-xs");
      expect(markup).not.toMatch(/text-muted-foreground\/\d+/u);
    }
  });
});

describe("manualUpdateInstructions", () => {
  it("gives copy-paste steps that mention the running version", () => {
    const instructions = manualUpdateInstructions("0.4.2");
    expect(instructions).toContain("bibcode serve");
    expect(instructions).toContain("0.4.2");
  });
});
