import {
  BearerConnectionCredential,
  ConnectionProfile,
  DirectHttpsRoute,
  DesktopLoopbackRoute,
  KnownEnvironment,
  PersistedConnectionTarget,
  SshTunnelRoute,
  storageIdentityTargetKey,
  type ConnectionProfile as ConnectionProfileType,
  type ConnectionTarget,
  type EnvironmentRoute,
  type KnownEnvironment as KnownEnvironmentType,
} from "@bibcode/client-runtime/connection";
import {
  AcceptedStorageIdentitySchema,
  type EnvironmentMigrationReceipt,
} from "@bibcode/client-runtime/platform";
import { LegacyConnectionCatalogV1 } from "@bibcode/client-runtime/platform/migration";
import { DurableEnvironmentId, TrimmedNonEmptyString } from "@bibcode/contracts";
import * as Schema from "effect/Schema";

export const CATALOG_V1_TO_V3_MIGRATION_ID = "catalog-v1-to-v3";
const MAX_FINGERPRINT_INPUT_BYTES = 65_536;

const StoredLegacyCredential = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  credential: BearerConnectionCredential,
});
type StoredLegacyCredential = typeof StoredLegacyCredential.Type;
const StorageInstanceId = Schema.String.check(Schema.isUUID());

const decodeLegacyCatalog = Schema.decodeUnknownSync(LegacyConnectionCatalogV1);
const decodeLegacyTarget = Schema.decodeUnknownSync(PersistedConnectionTarget);
const decodeLegacyProfile = Schema.decodeUnknownSync(ConnectionProfile);
const decodeLegacyCredential = Schema.decodeUnknownSync(StoredLegacyCredential);
const decodeAcceptedStorageIdentity = Schema.decodeUnknownSync(AcceptedStorageIdentitySchema);
const decodeDurableEnvironmentId = Schema.decodeUnknownSync(DurableEnvironmentId);
const decodeStorageInstanceId = Schema.decodeUnknownSync(StorageInstanceId);
const decodeDesktopLoopbackRoute = Schema.decodeUnknownSync(DesktopLoopbackRoute);
const decodeDirectHttpsRoute = Schema.decodeUnknownSync(DirectHttpsRoute);
const decodeSshTunnelRoute = Schema.decodeUnknownSync(SshTunnelRoute);
const decodeKnownEnvironment = Schema.decodeUnknownSync(KnownEnvironment);

export interface CatalogMigrationQuarantineEntry {
  readonly entryKind: "catalog" | "target" | "profile" | "credential" | "identity";
  readonly fingerprint: string;
  readonly code:
    | "invalid-metadata"
    | "missing-profile"
    | "missing-storage-identity"
    | "identity-conflict"
    | "unsafe-route";
}

export interface CatalogMigrationSessionSecretImport {
  readonly environmentId: DurableEnvironmentId;
  readonly routeId: string;
  readonly purpose: "environment-session";
  readonly value: string;
}

export interface CatalogMigrationMetadata {
  readonly environments: ReadonlyArray<KnownEnvironmentType>;
  readonly receipt: EnvironmentMigrationReceipt;
  readonly quarantine: ReadonlyArray<CatalogMigrationQuarantineEntry>;
  readonly discarded: {
    readonly relayTargets: number;
    readonly remoteDpopTokens: number;
  };
}

export interface CatalogMigrationPlan extends CatalogMigrationMetadata {
  /** Safe to persist or include in local redacted diagnostics. */
  readonly metadata: CatalogMigrationMetadata;
  /** Memory-only until the OS secret provider returns an opaque reference. */
  readonly sessionSecretImports: ReadonlyArray<CatalogMigrationSessionSecretImport>;
}

export interface CatalogMigrationOptions {
  readonly completedAt: string;
}

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, MAX_FINGERPRINT_INPUT_BYTES);
  } catch {
    return Object.prototype.toString.call(value).slice(0, MAX_FINGERPRINT_INPUT_BYTES);
  }
}

async function redactedFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(boundedJson(value));
  const bounded =
    bytes.byteLength <= MAX_FINGERPRINT_INPUT_BYTES
      ? bytes
      : bytes.slice(0, MAX_FINGERPRINT_INPUT_BYTES);
  if (globalThis.crypto?.subtle === undefined) {
    return "0".repeat(64);
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bounded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function quarantineEntry(
  entryKind: CatalogMigrationQuarantineEntry["entryKind"],
  code: CatalogMigrationQuarantineEntry["code"],
  value: unknown,
): Promise<CatalogMigrationQuarantineEntry> {
  return {
    entryKind,
    code,
    fingerprint: await redactedFingerprint(value),
  };
}

function parsedInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  return JSON.parse(input) as unknown;
}

interface PendingEnvironment {
  readonly environmentId: DurableEnvironmentId;
  readonly acceptedStorageInstanceId: string;
  readonly alias: string;
  readonly routes: Array<EnvironmentRoute>;
}

function decodeRoute(
  target: Exclude<ConnectionTarget, { readonly _tag: "RelayConnectionTarget" }>,
  profile: ConnectionProfileType,
  priority: number,
): EnvironmentRoute {
  const routeBase = {
    routeId: `legacy:${target._tag}:${"connectionId" in target ? target.connectionId : target.environmentId}`,
    environmentId: decodeDurableEnvironmentId(target.environmentId),
    label: target.label,
    priority,
    pinned: false,
    autoconnect: true,
    secretRef: null,
  } as const;

  if (target._tag === "BearerConnectionTarget" && profile._tag === "BearerConnectionProfile") {
    try {
      return decodeDesktopLoopbackRoute({
        _tag: "DesktopLoopbackRoute",
        ...routeBase,
        httpBaseUrl: profile.httpBaseUrl,
        wsBaseUrl: profile.wsBaseUrl,
      });
    } catch {
      return decodeDirectHttpsRoute({
        _tag: "DirectHttpsRoute",
        ...routeBase,
        httpsBaseUrl: profile.httpBaseUrl,
        trust: { _tag: "System" },
      });
    }
  }

  if (target._tag === "SshConnectionTarget" && profile._tag === "SshConnectionProfile") {
    return decodeSshTunnelRoute({
      _tag: "SshTunnelRoute",
      ...routeBase,
      target: profile.target,
      hostKeyFingerprint: null,
    });
  }

  throw new Error("Legacy target/profile kinds do not match.");
}

function emptyPlan(
  completedAt: string,
  quarantine: ReadonlyArray<CatalogMigrationQuarantineEntry>,
): CatalogMigrationPlan {
  const metadata: CatalogMigrationMetadata = {
    environments: [],
    receipt: { id: CATALOG_V1_TO_V3_MIGRATION_ID, completedAt },
    quarantine,
    discarded: { relayTargets: 0, remoteDpopTokens: 0 },
  };
  return { ...metadata, metadata, sessionSecretImports: [] };
}

/**
 * Builds a deterministic, non-mutating migration plan. Secret values are kept
 * in a separately named memory-only collection and never enter metadata rows.
 */
export async function planCatalogV1ToV3Migration(
  input: unknown,
  options: CatalogMigrationOptions,
): Promise<CatalogMigrationPlan> {
  let document: LegacyConnectionCatalogV1;
  try {
    document = decodeLegacyCatalog(parsedInput(input));
  } catch {
    return emptyPlan(options.completedAt, [
      await quarantineEntry("catalog", "invalid-metadata", input),
    ]);
  }

  const quarantine: CatalogMigrationQuarantineEntry[] = [];
  const profiles = new Map<string, ConnectionProfileType>();
  for (const rawProfile of document.profiles) {
    try {
      const profile = decodeLegacyProfile(rawProfile);
      profiles.set(profile.connectionId, profile);
    } catch {
      quarantine.push(await quarantineEntry("profile", "invalid-metadata", rawProfile));
    }
  }

  const credentials = new Map<string, StoredLegacyCredential>();
  for (const rawCredential of document.credentials) {
    try {
      const credential = decodeLegacyCredential(rawCredential);
      credentials.set(credential.connectionId, credential);
    } catch {
      quarantine.push(await quarantineEntry("credential", "invalid-metadata", rawCredential));
    }
  }

  const acceptedStorageIdentities = new Map<string, string>();
  for (const rawIdentity of document.acceptedStorageIdentities) {
    try {
      const identity = decodeAcceptedStorageIdentity(rawIdentity);
      acceptedStorageIdentities.set(identity.targetKey, identity.storageInstanceId);
    } catch {
      quarantine.push(await quarantineEntry("identity", "invalid-metadata", rawIdentity));
    }
  }

  let relayTargets = 0;
  const pending = new Map<string, PendingEnvironment>();
  const sessionSecretImports: CatalogMigrationSessionSecretImport[] = [];

  for (const [targetIndex, rawTarget] of document.targets.entries()) {
    let target: PersistedConnectionTarget;
    try {
      target = decodeLegacyTarget(rawTarget);
    } catch {
      quarantine.push(await quarantineEntry("target", "invalid-metadata", rawTarget));
      continue;
    }
    if (target._tag === "RelayConnectionTarget") {
      relayTargets += 1;
      continue;
    }

    const profile = profiles.get(target.connectionId);
    if (profile === undefined || profile.environmentId !== target.environmentId) {
      quarantine.push(await quarantineEntry("target", "missing-profile", rawTarget));
      continue;
    }

    let environmentId: DurableEnvironmentId;
    let acceptedStorageInstanceId: string;
    try {
      environmentId = decodeDurableEnvironmentId(target.environmentId);
      const storedIdentity = acceptedStorageIdentities.get(storageIdentityTargetKey(target));
      if (storedIdentity === undefined) throw new Error("Missing accepted storage identity.");
      acceptedStorageInstanceId = decodeStorageInstanceId(storedIdentity);
    } catch {
      quarantine.push(
        await quarantineEntry("identity", "missing-storage-identity", {
          targetKey: storageIdentityTargetKey(target),
        }),
      );
      continue;
    }

    let route: EnvironmentRoute;
    try {
      route = decodeRoute(target, profile, targetIndex);
    } catch {
      quarantine.push(await quarantineEntry("target", "unsafe-route", rawTarget));
      continue;
    }

    const existing = pending.get(environmentId);
    if (
      existing !== undefined &&
      existing.acceptedStorageInstanceId !== acceptedStorageInstanceId
    ) {
      quarantine.push(await quarantineEntry("identity", "identity-conflict", rawTarget));
      continue;
    }
    if (existing === undefined) {
      pending.set(environmentId, {
        environmentId,
        acceptedStorageInstanceId,
        alias: target.label,
        routes: [route],
      });
    } else if (!existing.routes.some((candidate) => candidate.routeId === route.routeId)) {
      existing.routes.push(route);
    }

    if (target._tag === "BearerConnectionTarget") {
      const credential = credentials.get(target.connectionId);
      if (credential !== undefined) {
        sessionSecretImports.push({
          environmentId,
          routeId: route.routeId,
          purpose: "environment-session",
          value: credential.credential.token,
        });
      }
    }
  }

  const environments: KnownEnvironmentType[] = [];
  for (const environment of pending.values()) {
    try {
      environments.push(
        decodeKnownEnvironment({
          environmentId: environment.environmentId,
          acceptedStorageInstanceId: environment.acceptedStorageInstanceId,
          descriptor: null,
          alias: environment.alias,
          hidden: false,
          bindings: [],
          routes: environment.routes,
        }),
      );
    } catch {
      quarantine.push(await quarantineEntry("target", "invalid-metadata", environment.routes));
    }
  }

  const metadata: CatalogMigrationMetadata = {
    environments,
    receipt: { id: CATALOG_V1_TO_V3_MIGRATION_ID, completedAt: options.completedAt },
    quarantine,
    discarded: {
      relayTargets,
      remoteDpopTokens: document.remoteDpopTokens.length,
    },
  };
  return { ...metadata, metadata, sessionSecretImports };
}
