import type { NativeSharingRoutePorts } from "./release-visual-native-sharing-route.ts";
export interface NativeSharingNetworkInput {
  readonly CI: string;
  readonly platform: string;
  readonly hostNet: string;
  readonly namespaces: Readonly<{ net: string; pid: string; user: string }>;
  readonly ip: string;
  readonly readNamespace: (owner: "self" | "1", kind: "net" | "pid" | "user") => Promise<string>;
  readonly readCapabilities: () => Promise<string>;
  readonly verifyExecutable: () => Promise<boolean>;
  readonly run: (args: readonly string[]) => Promise<{
    readonly exitCode: number;
    readonly reaped: boolean;
    readonly timedOut: boolean;
    readonly stdout: string;
  }>;
  readonly unsafeCleanup: () => void;
}
const refused = () => new Error("Owned native sharing network refused.");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refused();
  return value as Record<string, unknown>;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 64) throw refused();
  return value.map(object);
}
export function createNativeSharingRoutePorts(
  input: NativeSharingNetworkInput,
): NativeSharingRoutePorts {
  if (
    input.CI !== "true" ||
    input.platform !== "linux" ||
    !/^\/[^\0\r\n]+$/.test(input.ip) ||
    !/^net:\[\d+\]$/.test(input.hostNet) ||
    input.hostNet === input.namespaces.net
  )
    throw refused();
  let originalInventory: string | undefined;
  // Private canonical inventory never becomes an uploaded observation or error value.
  const inventory = (value: unknown, depth = 0): string => {
    if (depth > 16) throw refused();
    if (value === null || typeof value === "string" || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value))
      return (
        "[" +
        value
          .map((item) => inventory(item, depth + 1))
          .sort()
          .join(",") +
        "]"
      );
    const row = object(value);
    return (
      "{" +
      Object.keys(row)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + inventory(row[key], depth + 1))
        .join(",") +
      "}"
    );
  };
  const guard = async () => {
    const self = {
      net: await input.readNamespace("self", "net"),
      pid: await input.readNamespace("self", "pid"),
      user: await input.readNamespace("self", "user"),
    };
    const owner = {
      net: await input.readNamespace("1", "net"),
      pid: await input.readNamespace("1", "pid"),
      user: await input.readNamespace("1", "user"),
    };
    for (const key of ["net", "pid", "user"] as const)
      if (
        !new RegExp("^" + key + ":\\[\\d+\\]$").test(self[key]) ||
        self[key] !== input.namespaces[key] ||
        owner[key] !== self[key]
      )
        throw refused();
    const capabilities = await input.readCapabilities();
    if (capabilities.length > 8192) throw refused();
    const match = /^CapEff:\s*([0-9a-fA-F]{1,16})$/m.exec(capabilities);
    if (
      !match ||
      (BigInt("0x" + match[1]) & (1n << 12n)) === 0n ||
      !(await input.verifyExecutable())
    )
      throw refused();
    return { self, owner };
  };
  const command = async (args: readonly string[], read = true) => {
    await guard();
    const result = await input.run(args);
    if (
      result.exitCode !== 0 ||
      result.reaped !== true ||
      result.timedOut !== false ||
      typeof result.stdout !== "string" ||
      result.stdout.length > 65536
    )
      throw refused();
    if (!read) return [];
    try {
      return rows(JSON.parse(result.stdout));
    } catch {
      throw refused();
    }
  };
  const observe = async () => {
    const identity = await guard();
    const links = await command(["-j", "-d", "link", "show"]),
      addresses = await command(["-j", "address", "show"]),
      routes4 = await command(["-j", "-4", "route", "show", "table", "main"]),
      routes6 = await command(["-j", "-6", "route", "show", "table", "main"]);
    const names = ["lo", "bcup-in", "bcup-peer"];
    if (
      links.length !== 3 ||
      new Set(links.map((row) => row.ifname)).size !== 3 ||
      links.some((row) => !names.includes(String(row.ifname))) ||
      new Set(links.map((row) => row.ifindex)).size !== 3
    )
      throw refused();
    for (const row of links) {
      if (!Number.isSafeInteger(row.ifindex) || Number(row.ifindex) < 1) throw refused();
      const flags = row.flags;
      if (!Array.isArray(flags) || !flags.includes("UP")) throw refused();
      if (
        row.ifname !== "lo" &&
        (object(row.linkinfo).info_kind !== "veth" ||
          row.link !== (row.ifname === "bcup-in" ? "bcup-peer" : "bcup-in") ||
          !flags.includes("LOWER_UP") ||
          "link_index" in row ||
          "link_netnsid" in row ||
          "link-netnsid" in row)
      )
        throw refused();
    }
    if (
      addresses.length !== 3 ||
      new Set(addresses.map((row) => row.ifname)).size !== 3 ||
      addresses.some((row) => !names.includes(String(row.ifname)))
    )
      throw refused();
    for (const row of addresses) {
      const infos = rows(row.addr_info);
      const expected =
        row.ifname === "lo"
          ? "127.0.0.1"
          : row.ifname === "bcup-in"
            ? "10.254.231.1"
            : "10.254.231.2";
      let ipv4 = 0;
      for (const address of infos) {
        if (address.family === "inet") {
          if (address.local !== expected || address.prefixlen !== (row.ifname === "lo" ? 8 : 30))
            throw refused();
          ipv4++;
        } else if (
          address.family !== "inet6" ||
          typeof address.local !== "string" ||
          !(row.ifname === "lo"
            ? address.local === "::1" && address.prefixlen === 128
            : /^fe[89ab][0-9a-f]:/i.test(address.local) && address.prefixlen === 64)
        )
          throw refused();
      }
      if (ipv4 !== 1) throw refused();
    }
    const defaults = routes4.filter((row) => row.dst === "default");
    if (defaults.length > 1 || routes6.some((row) => row.dst === "default")) throw refused();
    if (
      defaults.length === 1 &&
      (defaults[0]!.gateway !== "10.254.231.2" || defaults[0]!.dev !== "bcup-in")
    )
      throw refused();
    for (const row of [...routes4, ...routes6]) {
      if (row.dst === "default") continue;
      if (
        row.dev === "lo" &&
        ["127.0.0.0/8", "::1", "::1/128"].includes(String(row.dst)) &&
        row.protocol === "kernel" &&
        !("gateway" in row)
      )
        continue;
      if (
        !["bcup-in", "bcup-peer"].includes(String(row.dev)) ||
        row.protocol !== "kernel" ||
        "gateway" in row ||
        !["10.254.231.0/30", "fe80::/64"].includes(String(row.dst))
      )
        throw refused();
      if (
        "prefsrc" in row &&
        row.prefsrc !== (row.dev === "bcup-in" ? "10.254.231.1" : "10.254.231.2")
      )
        throw refused();
    }
    const currentInventory = inventory({
      links,
      addresses,
      routes4: routes4.filter((row) => row.dst !== "default"),
      routes6,
    });
    if (originalInventory === undefined) originalInventory = currentInventory;
    else if (currentInventory !== originalInventory) throw refused();
    await guard();
    return {
      platform: "linux",
      CI: "true",
      hostNet: input.hostNet,
      ...identity,
      netAdmin: true,
      ipExecutablePinned: true,
      loopbackReady: true,
      interfacesOwned: true,
      addressesOwned: true,
      peerNamespacesOwned: true,
      kernelRoutesOwned: true,
      defaultRoute: defaults.length === 1 ? ("owned" as const) : ("absent" as const),
    };
  };
  return {
    observe,
    change: async (operation) => {
      if (operation !== "remove" && operation !== "restore") throw refused();
      const before = await observe();
      if (before.defaultRoute !== (operation === "remove" ? "owned" : "absent")) throw refused();
      await command(
        [
          "route",
          operation === "remove" ? "del" : "add",
          "default",
          "via",
          "10.254.231.2",
          "dev",
          "bcup-in",
        ],
        false,
      );
    },
    unsafeCleanup: input.unsafeCleanup,
  };
}
