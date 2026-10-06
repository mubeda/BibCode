// @effect-diagnostics nodeBuiltinImport:off - Only inert command and namespace ports exercise the network adapter.
import { expect, it } from "vite-plus/test";
import { createNativeSharingRoutePorts } from "./release-visual-native-sharing-network.ts";
import { withNativeSharingRoute } from "./release-visual-native-sharing-route.ts";
function fixture(mode = "owned") {
  let route = true,
    kernelMetric = 0;
  const calls: string[][] = [];
  const rows = {
    links: [
      { ifindex: 1, ifname: "lo", flags: ["UP"] },
      {
        ifindex: 2,
        ifname: "bcup-in",
        link: "bcup-peer",
        linkinfo: { info_kind: "veth" },
        flags: ["UP", "LOWER_UP"],
      },
      {
        ifindex: 3,
        ifname: "bcup-peer",
        link: "bcup-in",
        linkinfo: { info_kind: "veth" },
        flags: ["UP", "LOWER_UP"],
      },
    ],
    addresses: [
      { ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8 }] },
      { ifname: "bcup-in", addr_info: [{ family: "inet", local: "10.254.231.1", prefixlen: 30 }] },
      {
        ifname: "bcup-peer",
        addr_info: [{ family: "inet", local: "10.254.231.2", prefixlen: 30 }],
      },
    ],
  };
  const ports = createNativeSharingRoutePorts({
    CI: "true",
    platform: "linux",
    hostNet: "net:[1]",
    namespaces: { net: "net:[2]", pid: "pid:[3]", user: "user:[4]" },
    ip: "/owned/ip",
    readNamespace: async (owner: "self" | "1", kind: "net" | "pid" | "user") =>
      mode === "namespace" && owner === "1" && kind === "net"
        ? "net:[9]"
        : { net: "net:[2]", pid: "pid:[3]", user: "user:[4]" }[kind],
    readCapabilities: async () =>
      mode === "capability" ? "CapEff:\t0000000000000000\n" : "CapEff:\t0000000000001000\n",
    verifyExecutable: async () => mode !== "executable",
    unsafeCleanup: () => {},
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      let data: unknown = [];
      if (args.join(" ") === "-j -d link show")
        data = mode === "interface" ? [...rows.links, { ifindex: 4, ifname: "eth0" }] : rows.links;
      else if (args.join(" ") === "-j address show") data = rows.addresses;
      else if (args.join(" ") === "-j -4 route show table main")
        data = [
          {
            dst: "10.254.231.0/30",
            dev: "bcup-in",
            protocol: "kernel",
            prefsrc: "10.254.231.1",
            metric: kernelMetric,
          },
          ...(route
            ? [
                {
                  dst: "default",
                  gateway: mode === "route" ? "10.0.0.1" : "10.254.231.2",
                  dev: "bcup-in",
                },
              ]
            : []),
        ];
      else if (args[0] === "route") route = args[1] === "add";
      if (mode === "duplicate-index" && args.join(" ") === "-j -d link show") {
        data = rows.links.map((row) => ({ ...row, ifindex: 1 }));
      }
      if (mode === "foreign-peer" && args.join(" ") === "-j -d link show") {
        data = rows.links.map((row) =>
          row.ifname === "bcup-in" ? { ...row, link: "foreign" } : row,
        );
      }
      if (mode === "foreign-address" && args.join(" ") === "-j address show") {
        data = rows.addresses.map((row) =>
          row.ifname === "bcup-in"
            ? { ...row, addr_info: [{ family: "inet", local: "10.0.0.1", prefixlen: 30 }] }
            : row,
        );
      }
      if (mode === "foreign-kernel-route" && args.join(" ") === "-j -4 route show table main") {
        data = [...(data as object[]), { dst: "10.0.0.0/8", dev: "bcup-in", protocol: "kernel" }];
      }
      return {
        exitCode: 0,
        reaped: mode !== "unreaped",
        timedOut: mode === "timeout",
        stdout: mode === "malformed" ? "{" : JSON.stringify(data),
      };
    },
  });
  return {
    ports,
    calls,
    route: () => route,
    replaceInterfaces: () => {
      for (const row of rows.links) if (row.ifname !== "lo") row.ifindex += 5;
    },
    replaceAddresses: () => {
      rows.addresses[1]!.addr_info.push({ family: "inet6", local: "fe80::123", prefixlen: 64 });
    },
    replaceKernelRoute: () => {
      kernelMetric = 5;
    },
  };
}
it("observes actual fixed ip JSON shape and changes only the admitted default route", async () => {
  const f = fixture();
  await withNativeSharingRoute(f.ports, async (scope) => {
    expect(f.route()).toBe(false);
    await scope.restore();
  });
  expect(f.calls.filter((args) => args[0] === "route")).toEqual([
    ["route", "del", "default", "via", "10.254.231.2", "dev", "bcup-in"],
    ["route", "add", "default", "via", "10.254.231.2", "dev", "bcup-in"],
  ]);
  expect(f.route()).toBe(true);
});
it("refuses restoring a default route through a replacement veth pair in the same namespace", async () => {
  const f = fixture();
  await expect(
    withNativeSharingRoute(f.ports, async (scope) => {
      f.replaceInterfaces();
      await scope.restore();
    }),
  ).rejects.toThrow();
  expect(f.calls.filter((args) => args[0] === "route")).toEqual([
    ["route", "del", "default", "via", "10.254.231.2", "dev", "bcup-in"],
  ]);
  expect(f.route()).toBe(false);
});
it.each(["addresses", "kernel"])(
  "pins the original non-default %s inventory across route changes",
  async (kind) => {
    const f = fixture();
    await expect(
      withNativeSharingRoute(f.ports, async (scope) => {
        if (kind === "addresses") f.replaceAddresses();
        else f.replaceKernelRoute();
        await scope.restore();
      }),
    ).rejects.toThrow();
    expect(f.calls.filter((args) => args[0] === "route")).toHaveLength(1);
  },
);
it.each(["namespace", "capability", "executable", "interface", "route"])(
  "refuses %s before any route command",
  async (mode) => {
    const f = fixture(mode);
    await expect(withNativeSharingRoute(f.ports, async () => {})).rejects.toThrow();
    expect(f.calls.some((args) => args[0] === "route")).toBe(false);
  },
);

it.each([
  "duplicate-index",
  "foreign-peer",
  "foreign-address",
  "foreign-kernel-route",
  "unreaped",
  "timeout",
  "malformed",
])("rejects malformed or foreign network result %s before route mutation", async (mode) => {
  const f = fixture(mode);
  await expect(withNativeSharingRoute(f.ports, async () => {})).rejects.toThrow();
  expect(f.calls.some((args) => args[0] === "route")).toBe(false);
});
