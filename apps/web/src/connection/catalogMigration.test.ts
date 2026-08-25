import { describe, expect, it } from "@effect/vitest";

import { planCatalogV1ToV3Migration } from "./catalogMigration.ts";

const ENVIRONMENT_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f001";
const STORAGE_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f101";
const COMPLETED_AT = "2026-08-25T12:00:00.000Z";

const emptyLegacyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  acceptedStorageIdentities: [],
} as const;

function directLegacyCatalog() {
  return {
    ...emptyLegacyCatalog,
    targets: [
      {
        _tag: "BearerConnectionTarget",
        environmentId: ENVIRONMENT_ID,
        label: "Build Linux",
        connectionId: "build-direct",
      },
    ],
    profiles: [
      {
        _tag: "BearerConnectionProfile",
        connectionId: "build-direct",
        environmentId: ENVIRONMENT_ID,
        label: "Build Linux",
        httpBaseUrl: "https://build.example.test",
        wsBaseUrl: "wss://build.example.test",
      },
    ],
    credentials: [
      {
        connectionId: "build-direct",
        credential: { _tag: "BearerConnectionCredential", token: "super-secret-token" },
      },
    ],
    acceptedStorageIdentities: [
      { targetKey: "bearer:build-direct", storageInstanceId: STORAGE_ID },
    ],
  } as const;
}

describe("catalog v1 to v3 migration planning", () => {
  it("plans a clean empty migration with one durable receipt", async () => {
    const plan = await planCatalogV1ToV3Migration(emptyLegacyCatalog, {
      completedAt: COMPLETED_AT,
    });

    expect(plan.environments).toEqual([]);
    expect(plan.receipt).toEqual({ id: "catalog-v1-to-v3", completedAt: COMPLETED_AT });
    expect(plan.quarantine).toEqual([]);
  });

  it("drops Relay-only metadata and cloud tokens", async () => {
    const plan = await planCatalogV1ToV3Migration(
      {
        ...emptyLegacyCatalog,
        targets: [
          {
            _tag: "RelayConnectionTarget",
            environmentId: ENVIRONMENT_ID,
            label: "Removed Connect environment",
          },
        ],
        remoteDpopTokens: [{ accessToken: "removed-cloud-token" }],
      },
      { completedAt: COMPLETED_AT },
    );

    expect(plan.environments).toEqual([]);
    expect(plan.discarded).toEqual({ relayTargets: 1, remoteDpopTokens: 1 });
    expect(JSON.stringify(plan.metadata)).not.toContain("removed-cloud-token");
  });

  it("creates one environment with a secure direct route and stages its secret in memory", async () => {
    const plan = await planCatalogV1ToV3Migration(directLegacyCatalog(), {
      completedAt: COMPLETED_AT,
    });

    expect(plan.environments).toMatchObject([
      {
        environmentId: ENVIRONMENT_ID,
        acceptedStorageInstanceId: STORAGE_ID,
        alias: "Build Linux",
        routes: [
          {
            _tag: "DirectHttpsRoute",
            environmentId: ENVIRONMENT_ID,
            httpsBaseUrl: "https://build.example.test",
            secretRef: null,
          },
        ],
      },
    ]);
    expect(plan.sessionSecretImports).toMatchObject([
      {
        environmentId: ENVIRONMENT_ID,
        purpose: "environment-session",
        value: "super-secret-token",
      },
    ]);
    expect(JSON.stringify(plan.metadata)).not.toContain("super-secret-token");
  });

  it("merges mixed direct and SSH routes only after both prove the same identity", async () => {
    const direct = directLegacyCatalog();
    const plan = await planCatalogV1ToV3Migration(
      {
        ...direct,
        targets: [
          ...direct.targets,
          {
            _tag: "SshConnectionTarget",
            environmentId: ENVIRONMENT_ID,
            label: "Build Linux over SSH",
            connectionId: "build-ssh",
          },
          {
            _tag: "RelayConnectionTarget",
            environmentId: ENVIRONMENT_ID,
            label: "Removed Connect route",
          },
        ],
        profiles: [
          ...direct.profiles,
          {
            _tag: "SshConnectionProfile",
            connectionId: "build-ssh",
            environmentId: ENVIRONMENT_ID,
            label: "Build Linux over SSH",
            target: {
              alias: "build",
              hostname: "build.example.test",
              username: "builder",
              port: 22,
            },
          },
        ],
        acceptedStorageIdentities: [
          ...direct.acceptedStorageIdentities,
          { targetKey: "ssh:build-ssh", storageInstanceId: STORAGE_ID },
        ],
      },
      { completedAt: COMPLETED_AT },
    );

    expect(plan.environments).toHaveLength(1);
    expect(plan.environments[0]?.routes.map((route) => route._tag)).toEqual([
      "DirectHttpsRoute",
      "SshTunnelRoute",
    ]);
    expect(plan.discarded.relayTargets).toBe(1);
  });

  it("maps a loopback bearer profile without permitting non-loopback plaintext HTTP", async () => {
    const loopback = directLegacyCatalog();
    const loopbackPlan = await planCatalogV1ToV3Migration(
      {
        ...loopback,
        profiles: [
          {
            ...loopback.profiles[0],
            httpBaseUrl: "http://127.0.0.1:48271",
            wsBaseUrl: "ws://127.0.0.1:48271",
          },
        ],
      },
      { completedAt: COMPLETED_AT },
    );
    expect(loopbackPlan.environments[0]?.routes[0]?._tag).toBe("DesktopLoopbackRoute");

    const unsafe = directLegacyCatalog();
    const unsafePlan = await planCatalogV1ToV3Migration(
      {
        ...unsafe,
        profiles: [
          {
            ...unsafe.profiles[0],
            httpBaseUrl: "http://build.example.test",
            wsBaseUrl: "ws://build.example.test",
          },
        ],
      },
      { completedAt: COMPLETED_AT },
    );
    expect(unsafePlan.environments).toEqual([]);
    expect(unsafePlan.quarantine).toMatchObject([{ entryKind: "target", code: "unsafe-route" }]);
  });

  it("isolates corrupt rows with bounded redacted diagnostics", async () => {
    const plan = await planCatalogV1ToV3Migration(
      {
        ...emptyLegacyCatalog,
        targets: [
          {
            _tag: "BearerConnectionTarget",
            environmentId: ENVIRONMENT_ID,
            label: "Invalid target",
            connectionId: { rawSecret: "do-not-report-this" },
          },
        ],
      },
      { completedAt: COMPLETED_AT },
    );

    expect(plan.environments).toEqual([]);
    expect(plan.quarantine).toHaveLength(1);
    expect(plan.quarantine[0]).toMatchObject({ entryKind: "target", code: "invalid-metadata" });
    expect(plan.quarantine[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(plan.metadata)).not.toContain("do-not-report-this");
  });

  it("is deterministic across retry before the transaction receipt commits", async () => {
    const first = await planCatalogV1ToV3Migration(directLegacyCatalog(), {
      completedAt: COMPLETED_AT,
    });
    const retry = await planCatalogV1ToV3Migration(directLegacyCatalog(), {
      completedAt: COMPLETED_AT,
    });

    expect(retry.metadata).toEqual(first.metadata);
    expect(retry.sessionSecretImports).toEqual(first.sessionSecretImports);
  });
});
