import { EnvironmentId, PreviewGatewayError, ThreadId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { readPreparedConnection, catalog } = vi.hoisted(() => ({
  readPreparedConnection: vi.fn(),
  catalog: { entries: new Map<string, unknown>() },
}));

vi.mock("~/state/session", () => ({ readPreparedConnection }));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: "catalog" } }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => catalog } }));

import {
  canonicalizePreviewUrl,
  type GatewayOpenMutation,
  releasePreviewTab,
  resetPreviewGatewayForTests,
  resolveForNavigation,
} from "./previewGateway";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const sshTarget = { alias: "box", hostname: "box.example", username: null, port: null };

const connection = (target: Record<string, unknown>, httpBaseUrl: string) => ({
  label: "Build box",
  httpBaseUrl,
  target,
});
const lan = () =>
  connection({ _tag: "BearerConnectionTarget", connectionId: "b:1" }, "http://192.168.1.5:3773");
const ssh = () =>
  connection({ _tag: "SshConnectionTarget", connectionId: "ssh:1" }, "http://127.0.0.1:45123");

type GatewayOpenResult = Awaited<ReturnType<GatewayOpenMutation>>;
const opened = (gatewayPort: number, capability = "CAP"): GatewayOpenResult =>
  AsyncResult.success({ gatewayPort, capability, expiresAtMs: 0 });
const refused = (reason: PreviewGatewayError["reason"]): GatewayOpenResult =>
  AsyncResult.failure(Cause.fail(new PreviewGatewayError({ reason, message: reason })));

let sshForward: ReturnType<typeof vi.fn>;
let releaseSshForward: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetPreviewGatewayForTests();
  readPreparedConnection.mockReset();
  catalog.entries = new Map([
    [
      environmentId,
      {
        target: { _tag: "SshConnectionTarget" },
        profile: Option.some({ _tag: "SshConnectionProfile", target: sshTarget }),
      },
    ],
  ]);
  let nextLocalPort = 50_000;
  sshForward = vi.fn(async () => nextLocalPort++);
  releaseSshForward = vi.fn(async () => undefined);
  vi.stubGlobal("window", { desktopBridge: { sshForward, releaseSshForward } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveForNavigation", () => {
  it("resolves LAN loopback through the gateway with a bootstrap url", async () => {
    readPreparedConnection.mockReturnValue(lan());
    const gatewayOpen = vi.fn(async () => opened(41000));

    await expect(
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "http://localhost:5173/app?key=1#h",
        gatewayOpen,
      }),
    ).resolves.toEqual({
      kind: "ok",
      url: "http://192.168.1.5:41000/__bibcode/bootstrap?cap=CAP&to=%2Fapp%3Fkey%3D1%23h",
    });
    expect(gatewayOpen).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, url: "http://localhost:5173/app?key=1#h" },
    });
    expect(sshForward).not.toHaveBeenCalled();
  });

  it("resolves SSH loopback through gateway plus local forward", async () => {
    readPreparedConnection.mockReturnValue(ssh());
    const gatewayOpen = vi.fn(async () => opened(41000, "C+/="));

    await expect(
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "http://127.0.0.1:5173/",
        gatewayOpen,
      }),
    ).resolves.toEqual({
      kind: "ok",
      url: "http://127.0.0.1:50000/__bibcode/bootstrap?cap=C%2B%2F%3D&to=%2F",
    });
    // The canonical URL the server sees is always on localhost.
    expect(gatewayOpen).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, url: "http://localhost:5173/" },
    });
    expect(sshForward).toHaveBeenCalledWith(sshTarget, 41000);
  });

  it("maps https rejection to the HTTPS copy", async () => {
    readPreparedConnection.mockReturnValue(lan());
    const gatewayOpen = vi.fn(async () => refused("https-unsupported"));

    await expect(
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "https://localhost:8443/",
        gatewayOpen,
      }),
    ).resolves.toEqual({
      kind: "unreachable",
      message:
        "HTTPS dev servers can't be previewed through the gateway yet; serve over HTTP or open it on Build box directly.",
    });
  });

  it("maps a not-admitted rejection to the open-it-first copy", async () => {
    readPreparedConnection.mockReturnValue(lan());
    const gatewayOpen = vi.fn(async () => refused("not-admitted"));

    await expect(
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "http://localhost:5173/",
        gatewayOpen,
      }),
    ).resolves.toEqual({
      kind: "unreachable",
      message: "Open this address from the thread's terminal or chat first, then try again.",
    });
  });

  it("keeps same-host loopback direct without calling gatewayOpen", async () => {
    readPreparedConnection.mockReturnValue(
      connection({ _tag: "PrimaryConnectionTarget" }, "http://127.0.0.1:3773"),
    );
    const gatewayOpen = vi.fn();

    await expect(
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "http://localhost:5173/x",
        gatewayOpen,
      }),
    ).resolves.toEqual({ kind: "ok", url: "http://localhost:5173/x" });
    expect(gatewayOpen).not.toHaveBeenCalled();
  });

  it("reports relay environments as unreachable", async () => {
    readPreparedConnection.mockReturnValue(
      connection({ _tag: "RelayConnectionTarget" }, "https://abc.connect.example.com"),
    );
    const gatewayOpen = vi.fn();

    await expect(
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "http://localhost:5173/",
        gatewayOpen,
      }),
    ).resolves.toEqual({
      kind: "unreachable",
      message:
        "This address is on Build box, not this computer. Opening its ports from here isn't supported yet.",
    });
    expect(gatewayOpen).not.toHaveBeenCalled();
  });
});

describe("canonicalizePreviewUrl", () => {
  it("canonicalizes gateway and bootstrap urls back to localhost", async () => {
    readPreparedConnection.mockReturnValue(lan());
    await resolveForNavigation({
      environmentId,
      threadId,
      canonicalUrl: "http://localhost:5173/",
      gatewayOpen: async () => opened(41000),
    });

    expect(
      canonicalizePreviewUrl(
        "http://192.168.1.5:41000/__bibcode/bootstrap?cap=CAP&to=%2Fapp%3Fkey%3D1%23h",
      ),
    ).toBe("http://localhost:5173/app?key=1#h");
    expect(canonicalizePreviewUrl("http://192.168.1.5:41000/docs?a=b#c")).toBe(
      "http://localhost:5173/docs?a=b#c",
    );
    expect(canonicalizePreviewUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(canonicalizePreviewUrl("not a url")).toBe("not a url");
  });

  it("keeps shared state canonical across clients", async () => {
    readPreparedConnection.mockReturnValue(lan());
    await resolveForNavigation({
      environmentId,
      threadId,
      canonicalUrl: "http://localhost:5173/",
      gatewayOpen: async () => opened(41000),
    });
    readPreparedConnection.mockReturnValue(ssh());
    await resolveForNavigation({
      environmentId,
      threadId,
      canonicalUrl: "http://localhost:5173/",
      gatewayOpen: async () => opened(41001),
    });

    expect(canonicalizePreviewUrl("http://192.168.1.5:41000/a")).toBe("http://localhost:5173/a");
    expect(canonicalizePreviewUrl("http://127.0.0.1:50000/b")).toBe("http://localhost:5173/b");
  });
});

describe("ssh forward bookkeeping", () => {
  it("releases the ssh forward when the last tab closes and on gateway port change", async () => {
    readPreparedConnection.mockReturnValue(ssh());
    const resolve = (tabId: string, gatewayPort: number, canonicalUrl = "http://localhost:5173/") =>
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl,
        tabId,
        gatewayOpen: async () => opened(gatewayPort),
      });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await resolve("tab-a", 41000);
      await resolve("tab-b", 41000);
      releasePreviewTab(environmentId, "tab-a");
      expect(releaseSshForward).toHaveBeenCalledTimes(cycle);
      releasePreviewTab(environmentId, "tab-b");
      expect(releaseSshForward).toHaveBeenCalledTimes(cycle + 1);
    }
    expect(releaseSshForward).toHaveBeenLastCalledWith(sshTarget, 41000);

    releaseSshForward.mockClear();
    await resolve("tab-a", 41000);
    await resolve("tab-a", 41002);
    expect(releaseSshForward.mock.calls).toEqual([[sshTarget, 41000]]);
    // A tab that moves to another upstream port keeps the old forward for its
    // Back history, and gives up both when it closes.
    await resolve("tab-a", 41003, "http://localhost:3000/");
    expect(releaseSshForward.mock.calls).toEqual([[sshTarget, 41000]]);
    releasePreviewTab(environmentId, "tab-a");
    expect(releaseSshForward.mock.calls).toEqual([
      [sshTarget, 41000],
      [sshTarget, 41002],
      [sshTarget, 41003],
    ]);
    releasePreviewTab(environmentId, "tab-a");
    expect(releaseSshForward).toHaveBeenCalledTimes(3);
  });

  it("keeps the current forward when a new address is refused", async () => {
    readPreparedConnection.mockReturnValue(ssh());
    await resolveForNavigation({
      environmentId,
      threadId,
      canonicalUrl: "http://localhost:5173/",
      tabId: "tab-a",
      gatewayOpen: async () => opened(41000),
    });
    await expect(
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "https://localhost:8443/",
        tabId: "tab-a",
        gatewayOpen: async () => refused("https-unsupported"),
      }),
    ).resolves.toMatchObject({ kind: "unreachable" });
    expect(releaseSshForward).not.toHaveBeenCalled();

    releasePreviewTab(environmentId, "tab-a");
    expect(releaseSshForward.mock.calls).toEqual([[sshTarget, 41000]]);
  });

  it("keeps both forwards when one tab's navigations overlap", async () => {
    readPreparedConnection.mockReturnValue(ssh());
    let finishFirst: (value: GatewayOpenResult) => void = () => undefined;
    const first = resolveForNavigation({
      environmentId,
      threadId,
      canonicalUrl: "http://localhost:5173/",
      tabId: "tab-a",
      gatewayOpen: () => new Promise((resolve) => (finishFirst = resolve)),
    });
    await resolveForNavigation({
      environmentId,
      threadId,
      canonicalUrl: "http://localhost:3000/",
      tabId: "tab-a",
      gatewayOpen: async () => opened(42000),
    });
    finishFirst(opened(41000));
    await first;
    expect(releaseSshForward).not.toHaveBeenCalled();

    releasePreviewTab(environmentId, "tab-a");
    expect(releaseSshForward.mock.calls.map(([, port]) => port).toSorted()).toEqual([41000, 42000]);
  });

  it("does not let a failed resolution release a pending sibling's forward", async () => {
    readPreparedConnection.mockReturnValue(ssh());
    let finishFirst: (value: GatewayOpenResult) => void = () => undefined;
    let finishSecond: (value: GatewayOpenResult) => void = () => undefined;
    const resolve = (gatewayOpen: GatewayOpenMutation) =>
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "http://localhost:5173/",
        tabId: "tab-a",
        gatewayOpen,
      });
    const first = resolve(() => new Promise((done) => (finishFirst = done)));
    const second = resolve(() => new Promise((done) => (finishSecond = done)));
    finishFirst(refused("unavailable"));
    await first;
    finishSecond(opened(41000));
    await expect(second).resolves.toMatchObject({ kind: "ok" });
    expect(releaseSshForward).not.toHaveBeenCalled();

    releasePreviewTab(environmentId, "tab-a");
    expect(releaseSshForward.mock.calls).toEqual([[sshTarget, 41000]]);
  });

  it("hands a closed tab's late forward to a pending peer", async () => {
    readPreparedConnection.mockReturnValue(ssh());
    const finishers: Array<(value: GatewayOpenResult) => void> = [];
    const resolve = (tabId: string) =>
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "http://localhost:5173/",
        tabId,
        gatewayOpen: () => new Promise((done) => finishers.push(done)),
      });
    const a = resolve("tab-a");
    const b = resolve("tab-b");
    releasePreviewTab(environmentId, "tab-a");
    finishers[0]!(opened(41000));
    await a;
    finishers[1]!(opened(41000));
    await b;
    expect(releaseSshForward).not.toHaveBeenCalled();

    releasePreviewTab(environmentId, "tab-b");
    expect(releaseSshForward.mock.calls).toEqual([[sshTarget, 41000]]);
  });

  it("keeps each thread's forward for the same upstream port", async () => {
    readPreparedConnection.mockReturnValue(ssh());
    let finishOpen: (value: GatewayOpenResult) => void = () => undefined;
    const threadA = resolveForNavigation({
      environmentId,
      threadId: ThreadId.make("thread-a"),
      canonicalUrl: "http://localhost:5173/",
      tabId: "tab-a",
      gatewayOpen: () => new Promise((resolve) => (finishOpen = resolve)),
    });
    releasePreviewTab(environmentId, "tab-a");
    await resolveForNavigation({
      environmentId,
      threadId: ThreadId.make("thread-b"),
      canonicalUrl: "http://localhost:5173/",
      tabId: "tab-b",
      gatewayOpen: async () => opened(42000),
    });
    finishOpen(opened(41000));
    await threadA;

    // Thread A's late, orphaned forward goes; thread B's live one stays.
    expect(releaseSshForward.mock.calls).toEqual([[sshTarget, 41000]]);
  });

  it("says when nothing is listening on the port", async () => {
    readPreparedConnection.mockReturnValue(lan());
    await expect(
      resolveForNavigation({
        environmentId,
        threadId,
        canonicalUrl: "http://localhost:5173/",
        gatewayOpen: async () => refused("no-upstream"),
      }),
    ).resolves.toEqual({
      kind: "unreachable",
      message: "Nothing is listening on port 5173 on Build box.",
    });
  });

  it("releases a forward established after its tab already closed", async () => {
    readPreparedConnection.mockReturnValue(ssh());
    let finishOpen: (value: ReturnType<typeof opened>) => void = () => undefined;
    const pending = resolveForNavigation({
      environmentId,
      threadId,
      canonicalUrl: "http://localhost:5173/",
      tabId: "tab-a",
      gatewayOpen: () => new Promise((resolve) => (finishOpen = resolve)),
    });
    releasePreviewTab(environmentId, "tab-a");
    finishOpen(opened(41000));
    await pending;

    expect(sshForward).toHaveBeenCalledTimes(1);
    expect(releaseSshForward.mock.calls).toEqual([[sshTarget, 41000]]);
  });
});
