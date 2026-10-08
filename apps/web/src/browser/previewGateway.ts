import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@bibcode/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget, EnvironmentId, ThreadId } from "@bibcode/contracts";
import * as Option from "effect/Option";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";

import { formatHost, resolvePreviewTarget, UNREACHABLE_MESSAGES } from "./browserTargetResolver";

export type GatewayOpenMutation = (input: {
  environmentId: EnvironmentId;
  input: { threadId: ThreadId; url: string };
}) => Promise<
  AtomCommandResult<{ gatewayPort: number; capability: string; expiresAtMs: number }, unknown>
>;

export type PreviewNavigationResolution =
  | { readonly kind: "ok"; readonly url: string }
  | {
      readonly kind: "unreachable";
      readonly message: string;
      /**
       * The server's gateway refused the URL, so every client sees the same
       * failure. Otherwise the cause is this client's own reach (SSH forward,
       * connection, transport) and must stay out of shared preview state.
       */
      readonly refusedByServer?: true;
    };

const BOOTSTRAP_PATH = "/__bibcode/bootstrap";

/** Client-facing gateway origin -> canonical origin (`http://localhost:<port>`). */
const canonicalOrigins = new Map<string, string>();

interface SshForward {
  readonly target: DesktopSshEnvironmentTarget;
  readonly gatewayPort: number;
  /** `http://127.0.0.1:<localPort>`; forgotten with the forward so a reused port isn't mapped. */
  readonly clientOrigin: string;
}

/**
 * One thread's canonical origin over SSH and the forward its tabs share (the
 * server keeps one gateway listener per thread and upstream port). The forward
 * lives while a tab holds the entry or a tab's resolution is still pending.
 */
interface SshForwardEntry {
  forward: SshForward | null;
  readonly holders: Set<string>;
  pending: number;
}

/** Per environment: `<threadId> <canonical origin>` -> forward bookkeeping. */
const sshForwards = new Map<EnvironmentId, Map<string, SshForwardEntry>>();

/** Bumped when a tab closes, so a resolution that outlives its tab never holds a forward. */
const tabGenerations = new Map<string, number>();

/** The SSH forward that last installed each local client origin. */
const originOwners = new Map<string, SshForward>();

/** Forgets a forward's client origin unless a newer forward has reused that local port. */
function forgetOrigin(forward: SshForward): void {
  if (originOwners.get(forward.clientOrigin) !== forward) return;
  originOwners.delete(forward.clientOrigin);
  canonicalOrigins.delete(forward.clientOrigin);
}

function releaseForward(forward: SshForward): void {
  forgetOrigin(forward);
  void window.desktopBridge
    ?.releaseSshForward(forward.target, forward.gatewayPort)
    .catch(() => undefined);
}

function readSshTarget(environmentId: EnvironmentId): DesktopSshEnvironmentTarget | null {
  const profile = appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.get(environmentId)?.profile;
  return profile !== undefined &&
    Option.isSome(profile) &&
    profile.value._tag === "SshConnectionProfile"
    ? profile.value.target
    : null;
}

function openEntry(environmentId: EnvironmentId, key: string): SshForwardEntry {
  let entries = sshForwards.get(environmentId);
  if (!entries) {
    entries = new Map();
    sshForwards.set(environmentId, entries);
  }
  let entry = entries.get(key);
  if (!entry) {
    entry = { forward: null, holders: new Set(), pending: 0 };
    entries.set(key, entry);
  }
  return entry;
}

function releaseIfUnused(environmentId: EnvironmentId, key: string, entry: SshForwardEntry): void {
  if (entry.holders.size > 0 || entry.pending > 0) return;
  if (sshForwards.get(environmentId)?.get(key) === entry)
    sshForwards.get(environmentId)?.delete(key);
  if (entry.forward) releaseForward(entry.forward);
}

/**
 * Stops tracking a closed tab; releases each SSH forward no tab uses any more.
 * A tab holds every origin it has shown until then, because its native
 * history can go Back to any of them without resolving again.
 */
export function releasePreviewTab(environmentId: EnvironmentId, tabId: string): void {
  tabGenerations.set(tabId, (tabGenerations.get(tabId) ?? 0) + 1);
  for (const [key, entry] of sshForwards.get(environmentId) ?? []) {
    if (entry.holders.delete(tabId)) releaseIfUnused(environmentId, key, entry);
  }
}

/** Resolve a canonical preview URL to the URL this client's webview should load. */
export async function resolveForNavigation(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  canonicalUrl: string;
  gatewayOpen: GatewayOpenMutation;
  /** The preview tab that will load the URL; ties an SSH forward to the tab's lifetime. */
  tabId?: string;
}): Promise<PreviewNavigationResolution> {
  const { environmentId, tabId } = input;
  const resolution = resolvePreviewTarget(environmentId, input.canonicalUrl);
  if (resolution.kind === "unreachable") {
    return {
      kind: "unreachable",
      message: UNREACHABLE_MESSAGES[resolution.reason](resolution.environmentLabel),
    };
  }
  if (resolution.kind === "reachable") return { kind: "ok", url: resolution.url };

  const canonical = new URL(resolution.url);
  const label = readPreparedConnection(environmentId)?.label ?? "This environment";
  // Opened before any await so a close or a sibling's failure during this
  // resolution cannot release the forward it is about to use.
  const key = `${input.threadId} ${canonical.origin}`;
  const tracked = resolution.via === "ssh" && tabId !== undefined;
  const entry = tracked ? openEntry(environmentId, key) : null;
  const generation = tabId === undefined ? 0 : (tabGenerations.get(tabId) ?? 0);
  if (entry) entry.pending += 1;
  const settle = (forward: SshForward | null) => {
    if (!entry || tabId === undefined) return;
    entry.pending -= 1;
    if (forward) {
      if (entry.forward && entry.forward.gatewayPort !== forward.gatewayPort) {
        releaseForward(entry.forward);
      } else if (entry.forward && entry.forward.clientOrigin !== forward.clientOrigin) {
        // Same listener, new local port (the tunnel reconnected): the old one is gone.
        forgetOrigin(entry.forward);
      }
      entry.forward = forward;
      if ((tabGenerations.get(tabId) ?? 0) === generation) entry.holders.add(tabId);
    }
    releaseIfUnused(environmentId, key, entry);
  };
  const fail = (failure: GatewayFailure): PreviewNavigationResolution => {
    settle(null);
    return { kind: "unreachable", ...failure };
  };

  const result = await input.gatewayOpen({
    environmentId,
    input: { threadId: input.threadId, url: resolution.url },
  });
  if (result._tag === "Failure") return fail(gatewayFailure(result, label, canonical));
  const { gatewayPort, capability } = result.value;

  let clientOrigin: string;
  if (resolution.via === "host") {
    clientOrigin = `http://${formatHost(resolution.host)}:${gatewayPort}`;
    canonicalOrigins.set(clientOrigin, canonical.origin);
  } else {
    const bridge = window.desktopBridge;
    if (!bridge) return fail({ message: UNREACHABLE_MESSAGES.ssh(label) });
    const target = readSshTarget(environmentId);
    if (!target) return fail({ message: retryMessage(label) });
    let localPort: number;
    try {
      // Forwards end when the managed tunnel reconnects; the bridge call is
      // idempotent while one is alive, so every navigation re-establishes it.
      localPort = await bridge.sshForward(target, gatewayPort);
    } catch {
      return fail({ message: UNREACHABLE_MESSAGES.disconnected(label) });
    }
    clientOrigin = `http://127.0.0.1:${localPort}`;
    const forward: SshForward = { target, gatewayPort, clientOrigin };
    // Mapped before settling: settling may release (and forget) it at once.
    canonicalOrigins.set(clientOrigin, canonical.origin);
    originOwners.set(clientOrigin, forward);
    // ponytail: an untracked open (no tab, e.g. the system browser) shares the
    // tab's forward and ends with it; give it its own lease if that matters.
    settle(forward);
  }

  const to = `${canonical.pathname}${canonical.search}${canonical.hash}`;
  return {
    kind: "ok",
    url: `${clientOrigin}${BOOTSTRAP_PATH}?cap=${encodeURIComponent(capability)}&to=${encodeURIComponent(to)}`,
  };
}

type GatewayFailure = { readonly message: string; readonly refusedByServer?: true };

const retryMessage = (label: string) =>
  `Couldn't open a preview connection to ${label}. Try again, or reconnect ${label} if it keeps failing.`;

function gatewayFailure(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  label: string,
  canonical: URL,
): GatewayFailure {
  const error = squashAtomCommandFailure(result) as { _tag?: unknown; reason?: unknown } | null;
  if (error?._tag !== "PreviewGatewayError") return { message: retryMessage(label) };
  const refused = (message: string): GatewayFailure => ({ message, refusedByServer: true });
  switch (error.reason) {
    case "https-unsupported":
      return refused(
        `HTTPS dev servers can't be previewed through the gateway yet; serve over HTTP or open it on ${label} directly.`,
      );
    case "not-admitted":
      return refused("Open this address from the thread's terminal or chat first, then try again.");
    case "no-upstream":
      // A stopped dev server is recoverable; say so instead of "unsupported".
      return refused(`Nothing is listening on port ${canonical.port || "80"} on ${label}.`);
    default:
      // An expired session, a gateway shutdown or a bind failure: worth retrying.
      return refused(retryMessage(label));
  }
}

/** True for this client's gateway bootstrap page, which immediately replaces itself. */
export function isGatewayBootstrapUrl(url: string | null): boolean {
  if (url === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname === BOOTSTRAP_PATH && canonicalOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

/** Map a client-side gateway URL back to its canonical http://localhost:<port> form; other URLs pass through. */
export function canonicalizePreviewUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const canonicalOrigin = canonicalOrigins.get(parsed.origin);
  if (canonicalOrigin === undefined) return url;
  if (parsed.pathname === BOOTSTRAP_PATH) {
    const to = parsed.searchParams.get("to");
    return `${canonicalOrigin}${to?.startsWith("/") ? to : "/"}`;
  }
  return `${canonicalOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Test seam. */
export function resetPreviewGatewayForTests(): void {
  canonicalOrigins.clear();
  originOwners.clear();
  sshForwards.clear();
  tabGenerations.clear();
}
