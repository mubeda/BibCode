// @effect-diagnostics nodeBuiltinImport:off - Reject untrusted opaque scopes before reflection.
import * as NodeUtil from "node:util";
export interface NativeSharingRouteObservation {
  readonly platform: string;
  readonly CI: string;
  readonly hostNet: string;
  readonly self: Readonly<{ net: string; pid: string; user: string }>;
  readonly owner: Readonly<{ net: string; pid: string; user: string }>;
  readonly netAdmin: boolean;
  readonly ipExecutablePinned: boolean;
  readonly loopbackReady: boolean;
  readonly interfacesOwned: boolean;
  readonly addressesOwned: boolean;
  readonly peerNamespacesOwned: boolean;
  readonly kernelRoutesOwned: boolean;
  readonly defaultRoute: "owned" | "absent" | "foreign";
}
export interface NativeSharingRoutePorts {
  readonly observe: () => Promise<NativeSharingRouteObservation>;
  readonly change: (operation: "remove" | "restore") => Promise<void>;
  readonly unsafeCleanup: () => void;
}
export interface NativeSharingRouteScope {
  readonly kind: "native-sharing-private-route";
  readonly restore: () => Promise<void>;
}
const refused = () => new Error("Owned native sharing route refused.");
interface RouteProof {
  readonly ports: NativeSharingRoutePorts;
  readonly namespaces: Readonly<{ net: string; pid: string; user: string; hostNet: string }>;
  state: "owned" | "absent";
  active: boolean;
}
const proofs = new WeakMap<NativeSharingRouteScope, RouteProof>();
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    throw refused();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    throw refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw refused();
    result[key] = field.value;
  }
  return result;
}
function observation(
  value: unknown,
  expected: "owned" | "absent",
  pinned?: RouteProof["namespaces"],
): RouteProof["namespaces"] {
  const data = fields(value, [
    "platform",
    "CI",
    "hostNet",
    "self",
    "owner",
    "netAdmin",
    "ipExecutablePinned",
    "loopbackReady",
    "interfacesOwned",
    "addressesOwned",
    "peerNamespacesOwned",
    "kernelRoutesOwned",
    "defaultRoute",
  ]);
  if (
    data.platform !== "linux" ||
    data.CI !== "true" ||
    typeof data.hostNet !== "string" ||
    !/^net:\[\d+\]$/.test(data.hostNet) ||
    data.defaultRoute !== expected ||
    (pinned !== undefined && data.hostNet !== pinned.hostNet)
  )
    throw refused();
  for (const key of [
    "netAdmin",
    "ipExecutablePinned",
    "loopbackReady",
    "interfacesOwned",
    "addressesOwned",
    "peerNamespacesOwned",
    "kernelRoutesOwned",
  ])
    if (data[key] !== true) throw refused();
  const self = fields(data.self, ["net", "pid", "user"]),
    owner = fields(data.owner, ["net", "pid", "user"]);
  for (const key of ["net", "pid", "user"] as const) {
    const value = self[key];
    if (
      typeof value !== "string" ||
      !new RegExp("^" + key + ":\\[\\d+\\]$").test(value) ||
      owner[key] !== value ||
      (pinned && pinned[key] !== value)
    )
      throw refused();
  }
  if (self.net === data.hostNet) throw refused();
  return Object.freeze({
    net: self.net as string,
    pid: self.pid as string,
    user: self.user as string,
    hostNet: data.hostNet,
  });
}
function proof(scope: unknown): RouteProof {
  if (!scope || typeof scope !== "object" || NodeUtil.types.isProxy(scope)) throw refused();
  const found = proofs.get(scope as NativeSharingRouteScope);
  if (!found?.active) throw refused();
  return found;
}
export async function readNativeSharingRoute(
  scope: unknown,
  expected: "owned" | "absent",
): Promise<void> {
  if (expected !== "owned" && expected !== "absent") throw refused();
  const current = proof(scope);
  if (current.state !== expected) throw refused();
  observation(await current.ports.observe(), expected, current.namespaces);
}
export async function withNativeSharingRoute<A>(
  ports: NativeSharingRoutePorts,
  run: (scope: NativeSharingRouteScope) => Promise<A>,
): Promise<A> {
  const namespaces = observation(await ports.observe(), "owned");
  const current: RouteProof = { ports, namespaces, state: "owned", active: true };
  const restore = async () => {
    if (!current.active) throw refused();
    observation(await ports.observe(), current.state, namespaces);
    if (current.state === "absent") {
      await ports.change("restore");
      observation(await ports.observe(), "owned", namespaces);
      current.state = "owned";
    }
  };
  const scope = Object.freeze({ kind: "native-sharing-private-route" as const, restore });
  proofs.set(scope, current);
  let failed = false,
    error: unknown,
    result: A | undefined,
    attempted = false;
  try {
    observation(await ports.observe(), "owned", namespaces);
    attempted = true;
    await ports.change("remove");
    current.state = "absent";
    observation(await ports.observe(), "absent", namespaces);
    result = await run(scope);
  } catch (original) {
    failed = true;
    error = original;
  }
  let cleanupFailed = false;
  try {
    if (attempted) {
      const actual = await ports.observe();
      try {
        observation(actual, "owned", namespaces);
        current.state = "owned";
      } catch {
        observation(actual, "absent", namespaces);
        current.state = "absent";
        await restore();
      }
    }
  } catch {
    cleanupFailed = true;
    try {
      ports.unsafeCleanup();
    } catch {
      /* Original operation remains authoritative. */
    }
  } finally {
    current.active = false;
    proofs.delete(scope);
  }
  if (failed) throw error;
  if (cleanupFailed) throw refused();
  return result as A;
}
