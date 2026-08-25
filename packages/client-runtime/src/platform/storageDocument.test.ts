import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  RelayConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  assembleKnownEnvironments,
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  LegacyConnectionCatalogV1,
  NormalizedEnvironmentCatalogRows,
  registerConnectionInCatalog,
  removeEnvironmentFromCatalogRows,
  removeConnectionFromCatalog,
} from "./storageDocument.ts";
import * as PublicPlatform from "./index.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
const REMOTE_TOKEN = new TokenStore.RemoteDpopAccessToken({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  endpoint: {
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test",
    providerKind: "cloudflare_tunnel",
  },
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
  dpopThumbprint: "thumbprint",
});
const decodeConnectionCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const decodeLegacyConnectionCatalogV1 = Schema.decodeUnknownSync(LegacyConnectionCatalogV1);
const decodeNormalizedEnvironmentCatalogRows = Schema.decodeUnknownSync(
  NormalizedEnvironmentCatalogRows,
);

const DURABLE_ENVIRONMENT_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f001";
const OTHER_DURABLE_ENVIRONMENT_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f002";
const DURABLE_STORAGE_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f101";

const normalizedEnvironment = {
  environmentId: DURABLE_ENVIRONMENT_ID,
  acceptedStorageInstanceId: DURABLE_STORAGE_ID,
  descriptor: null,
  alias: "Build Linux",
  hidden: false,
} as const;

const normalizedRoutes = [
  {
    _tag: "SshTunnelRoute",
    routeId: "route:ssh",
    environmentId: DURABLE_ENVIRONMENT_ID,
    label: "SSH tunnel",
    priority: 20,
    pinned: false,
    autoconnect: true,
    secretRef: "bibcode-secret:ssh-session",
    target: {
      alias: "build-server",
      hostname: "build.example.test",
      username: "builder",
      port: 22,
    },
    hostKeyFingerprint: "SHA256:known-host-key",
  },
  {
    _tag: "DirectHttpsRoute",
    routeId: "route:https",
    environmentId: DURABLE_ENVIRONMENT_ID,
    label: "Private HTTPS",
    priority: 10,
    pinned: true,
    autoconnect: true,
    secretRef: "bibcode-secret:https-session",
    httpsBaseUrl: "https://build.example.test",
    trust: { _tag: "System" },
  },
] as const;

describe("ConnectionCatalogDocument", () => {
  it("decodes a schema-v1 document without accepted storage identities", () => {
    const oldDocument = {
      schemaVersion: 1,
      targets: [BEARER_TARGET],
      profiles: [BEARER_PROFILE],
      credentials: [
        {
          connectionId: BEARER_TARGET.connectionId,
          credential: BEARER_CREDENTIAL,
        },
      ],
      remoteDpopTokens: [REMOTE_TOKEN],
    };

    expect(decodeConnectionCatalogDocument(oldDocument)).toEqual({
      ...oldDocument,
      acceptedStorageIdentities: [],
    });
    expect(EMPTY_CONNECTION_CATALOG_DOCUMENT.acceptedStorageIdentities).toEqual([]);
  });

  it("registers a bearer connection as one catalog mutation", () => {
    const document = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        acceptedStorageIdentities: [
          {
            targetKey: "bearer:bearer-1",
            storageInstanceId: "store-a",
          },
        ],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(document.targets).toEqual([BEARER_TARGET]);
    expect(document.profiles).toEqual([BEARER_PROFILE]);
    expect(document.credentials).toEqual([
      {
        connectionId: BEARER_TARGET.connectionId,
        credential: BEARER_CREDENTIAL,
      },
    ]);
    expect(document.acceptedStorageIdentities).toEqual([
      {
        targetKey: "bearer:bearer-1",
        storageInstanceId: "store-a",
      },
    ]);
  });

  it("replaces obsolete connection metadata without discarding a reusable DPoP token", () => {
    const bearer = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const relayTarget = new RelayConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
    });
    const relay = registerConnectionInCatalog(
      bearer,
      new RelayConnectionRegistration({ target: relayTarget }),
    );

    expect(relay.targets).toEqual([relayTarget]);
    expect(relay.profiles).toEqual([]);
    expect(relay.credentials).toEqual([]);
    expect(relay.remoteDpopTokens).toEqual([REMOTE_TOKEN]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, BEARER_TARGET)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("persists the normalized SSH profile beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([]);
  });
});

describe("normalized environment catalog rows", () => {
  it("keeps the legacy decoder bounded to unknown migration input", () => {
    const input = {
      schemaVersion: 1,
      targets: [{ _tag: "RemovedRelayShape", credential: "opaque-to-the-decoder" }],
      profiles: [{ future: true }],
      credentials: [{ secret: true }],
      remoteDpopTokens: [{ token: true }],
    };

    expect(decodeLegacyConnectionCatalogV1(input)).toEqual({
      ...input,
      acceptedStorageIdentities: [],
    });
    expect("LegacyConnectionCatalogV1" in PublicPlatform).toBe(false);
  });

  it("rejects orphan routes before publishing a partial catalog", () => {
    expect(() =>
      decodeNormalizedEnvironmentCatalogRows({
        environments: [normalizedEnvironment],
        routes: [
          {
            ...normalizedRoutes[0],
            environmentId: OTHER_DURABLE_ENVIRONMENT_ID,
          },
        ],
        bindings: [],
      }),
    ).toThrow(/route must reference a stored environment/iu);
  });

  it("rejects globally colliding route and binding identifiers", () => {
    expect(() =>
      decodeNormalizedEnvironmentCatalogRows({
        environments: [normalizedEnvironment],
        routes: [normalizedRoutes[0], { ...normalizedRoutes[1], routeId: "route:ssh" }],
        bindings: [],
      }),
    ).toThrow(/route identifiers must be globally unique/iu);

    const binding = {
      _tag: "DesktopWslBinding",
      bindingId: "wsl:Ubuntu",
      distroName: "Ubuntu",
      acceptedEnvironmentId: DURABLE_ENVIRONMENT_ID,
      acceptedStorageInstanceIds: [DURABLE_STORAGE_ID],
      acceptedAt: "2026-08-25T12:00:00.000Z",
      lastDiscoveryGeneration: 1,
      condition: "available",
      detail: null,
    } as const;
    expect(() =>
      decodeNormalizedEnvironmentCatalogRows({
        environments: [normalizedEnvironment],
        routes: [],
        bindings: [binding, { ...binding, distroName: "Debian" }],
      }),
    ).toThrow(/binding identifiers must be globally unique/iu);
  });

  it("assembles independent rows into one environment with several routes", () => {
    const rows = decodeNormalizedEnvironmentCatalogRows({
      environments: [normalizedEnvironment],
      routes: normalizedRoutes,
      bindings: [],
    });

    expect(assembleKnownEnvironments(rows)).toMatchObject([
      {
        environmentId: DURABLE_ENVIRONMENT_ID,
        routes: [{ routeId: "route:ssh" }, { routeId: "route:https" }],
      },
    ]);
  });

  it("removes an environment and all attached normalized rows as one value", () => {
    const binding = {
      _tag: "DesktopWslBinding",
      bindingId: "wsl:Ubuntu",
      distroName: "Ubuntu",
      acceptedEnvironmentId: DURABLE_ENVIRONMENT_ID,
      acceptedStorageInstanceIds: [DURABLE_STORAGE_ID],
      acceptedAt: "2026-08-25T12:00:00.000Z",
      lastDiscoveryGeneration: 1,
      condition: "available",
      detail: null,
    } as const;
    const rows = decodeNormalizedEnvironmentCatalogRows({
      environments: [normalizedEnvironment],
      routes: normalizedRoutes,
      bindings: [binding],
    });

    expect(removeEnvironmentFromCatalogRows(rows, rows.environments[0]!.environmentId)).toEqual({
      environments: [],
      routes: [],
      bindings: [],
    });
  });
});
