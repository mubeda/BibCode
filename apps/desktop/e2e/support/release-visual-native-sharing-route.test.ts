// @effect-diagnostics nodeBuiltinImport:off - Pure ownership and inert command ports; no network command executes.
import { expect, it } from "vite-plus/test";
import {
  withNativeSharingRoute,
  readNativeSharingRoute,
  type NativeSharingRoutePorts,
} from "./release-visual-native-sharing-route.ts";
const namespaces = { net: "net:[2]", pid: "pid:[3]", user: "user:[4]" } as const;
function ports(mode = "owned") {
  let route = true;
  const calls: string[] = [];
  const observe = () => ({
    platform: "linux",
    CI: "true",
    hostNet: mode === "host" ? namespaces.net : "net:[1]",
    self: namespaces,
    owner: mode === "owner" ? { ...namespaces, pid: "pid:[9]" } : namespaces,
    netAdmin: mode !== "capability",
    ipExecutablePinned: true,
    loopbackReady: true,
    interfacesOwned: mode !== "interfaces",
    addressesOwned: true,
    peerNamespacesOwned: true,
    kernelRoutesOwned: true,
    defaultRoute: route ? (mode === "foreign-route" ? "foreign" : "owned") : "absent",
  });
  const input = {
    observe: async () => {
      calls.push("observe");
      return observe();
    },
    change: async (operation: "remove" | "restore") => {
      calls.push(operation);
      if (mode === "command" && operation === "remove")
        throw new Error("Inert route command failure.");
      route = operation === "restore";
    },
    unsafeCleanup: () => calls.push("unsafe"),
  } as NativeSharingRoutePorts;
  return { input, calls, route: () => route };
}
it("removes and restores only the admitted private default and exposes an opaque bound scope", async () => {
  const f = ports();
  let escaped: unknown;
  await withNativeSharingRoute(f.input, async (scope) => {
    escaped = scope;
    expect(f.route()).toBe(false);
    await readNativeSharingRoute(scope, "absent");
    await scope.restore();
    expect(f.route()).toBe(true);
    await readNativeSharingRoute(scope, "owned");
  });
  expect(f.calls.filter((x) => x === "remove")).toHaveLength(1);
  expect(f.calls.filter((x) => x === "restore")).toHaveLength(1);
  expect(f.calls).not.toContain("unsafe");
  await expect(readNativeSharingRoute(escaped, "owned")).rejects.toThrow();
});
it.each(["host", "owner", "capability", "interfaces", "foreign-route"])(
  "refuses %s before any mutation",
  async (mode) => {
    const f = ports(mode);
    await expect(withNativeSharingRoute(f.input, async () => {})).rejects.toThrow();
    expect(f.calls).not.toContain("remove");
    expect(f.calls).not.toContain("restore");
  },
);
it("preserves the original operation error and restores the exact owned default on exit", async () => {
  const f = ports(),
    original = new Error("Inert original sharing failure.");
  await expect(
    withNativeSharingRoute(f.input, async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(f.route()).toBe(true);
  expect(f.calls.filter((x) => x === "restore")).toHaveLength(1);
});
it("refuses copied, live-proxy and revoked-proxy scopes before observing their ports", async () => {
  const f = ports();
  await withNativeSharingRoute(f.input, async (scope) => {
    const revoked = Proxy.revocable(scope, {});
    revoked.revoke();
    const before = f.calls.length;
    for (const value of [{ ...scope }, new Proxy(scope, {}), revoked.proxy])
      await expect(readNativeSharingRoute(value, "absent")).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
  });
});

it("flags unsafe restoration while preserving the original failed operation", async () => {
  const f = ports(),
    original = new Error("Inert original route failure.");
  const input = {
    ...f.input,
    change: async (operation: "remove" | "restore") => {
      if (operation === "restore") throw new Error("Inert restoration refusal.");
      await f.input.change(operation);
    },
  };
  await expect(
    withNativeSharingRoute(input, async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(f.calls).toContain("unsafe");
  expect(f.route()).toBe(false);
});
it("validates and restores a partially completed remove even when the command reports failure", async () => {
  const f = ports(),
    original = new Error("Inert post-mutation command failure.");
  const input = {
    ...f.input,
    change: async (operation: "remove" | "restore") => {
      await f.input.change(operation);
      if (operation === "remove") throw original;
    },
  };
  await expect(withNativeSharingRoute(input, async () => {})).rejects.toBe(original);
  expect(f.route()).toBe(true);
  expect(f.calls).not.toContain("unsafe");
});
it("refuses namespace drift instead of mutating the replacement namespace", async () => {
  const f = ports();
  let drift = false;
  const input = {
    ...f.input,
    observe: async () => {
      const value = await f.input.observe();
      return drift
        ? {
            ...value,
            self: { ...value.self, net: "net:[99]" },
            owner: { ...value.owner, net: "net:[99]" },
          }
        : value;
    },
  };
  await expect(
    withNativeSharingRoute(input, async (scope) => {
      drift = true;
      await scope.restore();
    }),
  ).rejects.toThrow();
  expect(f.calls.filter((value) => value === "restore")).toHaveLength(0);
  expect(f.calls).toContain("unsafe");
});
it("rejects observation getters and proxies before invoking their traps", async () => {
  const f = ports();
  let reads = 0;
  const raw = await f.input.observe();
  Object.defineProperty(raw, "netAdmin", {
    enumerable: true,
    get: () => {
      reads++;
      return true;
    },
  });
  await expect(
    withNativeSharingRoute({ ...f.input, observe: async () => raw }, async () => {}),
  ).rejects.toThrow();
  const proxy = new Proxy(
    {},
    {
      ownKeys: () => {
        reads++;
        return [];
      },
    },
  );
  await expect(
    withNativeSharingRoute({ ...f.input, observe: async () => proxy as never }, async () => {}),
  ).rejects.toThrow();
  expect(reads).toBe(0);
  expect(f.calls).not.toContain("remove");
});
it("revokes escaped restore functions without touching route observations", async () => {
  const f = ports();
  let restore: (() => Promise<void>) | undefined;
  await withNativeSharingRoute(f.input, async (scope) => {
    restore = scope.restore;
  });
  const before = f.calls.length;
  await expect(restore!()).rejects.toThrow();
  expect(f.calls).toHaveLength(before);
});

it("rejects a changed host namespace witness during the live private route scope", async () => {
  const f = ports();
  let drift = false;
  const input = {
    ...f.input,
    observe: async () => {
      const value = await f.input.observe();
      return drift ? { ...value, hostNet: "net:[88]" } : value;
    },
  };
  await expect(
    withNativeSharingRoute(input, async (scope) => {
      drift = true;
      await readNativeSharingRoute(scope, "absent");
    }),
  ).rejects.toThrow();
  expect(f.calls).toContain("unsafe");
  expect(f.calls.filter((value) => value === "restore")).toHaveLength(0);
});
