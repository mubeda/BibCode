import {
  isDesktopLocalConnectionId,
  type CompatVerdict,
  type PairingAddFailureReason,
} from "@bibcode/client-runtime/connection";

/** D16: version strings render as "BiBCode v<serverVersion>". */
export function formatServerVersionLabel(serverVersion: string | null | undefined): string | null {
  const trimmed = serverVersion?.trim() ?? "";
  return trimmed.length > 0 ? `BiBCode v${trimmed}` : null;
}

export type CompatBadge = {
  readonly tone: "warning" | "destructive";
  readonly label: string;
} | null;

export function describeCompatBadge(verdict: CompatVerdict | null): CompatBadge {
  if (verdict === null) return null;
  switch (verdict.kind) {
    case "compatible":
      return null;
    case "legacy":
      return { tone: "warning", label: "Limited compatibility" };
    case "server-too-old":
      return { tone: "destructive", label: "Server update required" };
    case "client-too-old":
      return { tone: "destructive", label: "App update required" };
  }
}

/**
 * Structural input so the helper stays pure and unit-testable without
 * constructing full catalog entries. EnvironmentPresentation satisfies it.
 */
export interface TransportBadgeInput {
  readonly relayManaged: boolean;
  readonly entry: {
    readonly target: { readonly _tag: string; readonly connectionId?: string };
    readonly profile:
      | { readonly _tag: "None" }
      | {
          readonly _tag: "Some";
          readonly value: { readonly _tag: string; readonly hostKey?: string | null };
        };
  };
}

export type TransportBadge =
  | { readonly kind: "e2ee" | "ssh" | "relay"; readonly label: string }
  | { readonly kind: "unencrypted"; readonly label: string; readonly guidance: string };

export function resolveTransportBadge(environment: TransportBadgeInput): TransportBadge | null {
  if (environment.relayManaged) return { kind: "relay", label: "BiBCode Connect" };
  const target = environment.entry.target;
  if (target._tag === "SshConnectionTarget") return { kind: "ssh", label: "SSH tunnel" };
  if (target._tag !== "BearerConnectionTarget") return null;
  if (isDesktopLocalConnectionId(target.connectionId)) return null;
  const profile = environment.entry.profile;
  const hostKey =
    profile._tag === "Some" && profile.value._tag === "BearerConnectionProfile"
      ? (profile.value.hostKey ?? null)
      : null;
  if (hostKey !== null && hostKey.length > 0) {
    return { kind: "e2ee", label: "End-to-end encrypted" };
  }
  return {
    kind: "unencrypted",
    label: "Unencrypted",
    guidance: "Re-pair with a new pairing code to secure this connection.",
  };
}

export const ADD_SERVER_FAILURE_REASONS: ReadonlyArray<PairingAddFailureReason> = [
  "unreachable",
  "host-identity-mismatch",
  "pairing-rejected",
  "incompatible",
  "duplicate-storage-identity",
];

export function resolvePairingAddFailureReason(error: unknown): PairingAddFailureReason | null {
  if (error === null || typeof error !== "object") return null;
  if ((error as { _tag?: unknown })._tag !== "PairingAddError") return null;
  const reason = (error as { reason?: unknown }).reason;
  return (ADD_SERVER_FAILURE_REASONS as readonly unknown[]).includes(reason)
    ? (reason as PairingAddFailureReason)
    : null;
}

export function isLoopbackAcknowledgementRequired(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { _tag?: unknown })._tag === "PairingLoopbackAcknowledgementRequiredError"
  );
}

export function describeAddServerFailure(reason: PairingAddFailureReason): {
  readonly title: string;
  readonly detail: string;
} {
  switch (reason) {
    case "unreachable":
      return {
        title: "Server unreachable",
        detail:
          "Could not reach the server at the pairing code's address. Check that the server is running and that this device can reach its network.",
      };
    case "host-identity-mismatch":
      return {
        title: "Host identity changed",
        detail:
          "The server's identity key does not match this pairing code. Generate a fresh pairing code on the server and try again.",
      };
    case "pairing-rejected":
      return {
        title: "Pairing rejected",
        detail:
          "The server rejected this pairing code. Codes are single-use and expire — generate a new one on the server.",
      };
    case "incompatible":
      return {
        title: "Versions incompatible",
        detail:
          "This app and the server cannot talk to each other. Update the older side, then retry.",
      };
    case "duplicate-storage-identity":
      return {
        title: "Server already saved",
        detail:
          "A saved server already uses this server's storage identity. Reconnect or adopt the existing entry instead of adding a duplicate.",
      };
  }
}

/** Accepts bare codes, bibcode deep links, and HTTP(S) pairing URLs. */
export function normalizePairingCodeInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^[A-Za-z0-9_-]+$/u.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code")?.trim() ?? "";
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

export function countRunningThreadsForEnvironment(
  shells: ReadonlyArray<{
    readonly environmentId: string;
    readonly session?: { readonly status?: string } | null;
  }>,
  environmentId: string,
): number {
  return shells.filter(
    (shell) => shell.environmentId === environmentId && shell.session?.status === "running",
  ).length;
}
