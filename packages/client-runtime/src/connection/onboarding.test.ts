import { AuthStandardClientScopes, EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import { ClientPresentation, SshEnvironmentGateway } from "../platform/capabilities.ts";
import { BearerConnectionCredential, BearerConnectionProfile } from "./catalog.ts";
import { EnvironmentRegistry, type EnvironmentRegistrationInput } from "./registry.ts";
import { BearerConnectionTarget } from "./model.ts";
import {
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
  registerPairingConnection,
} from "./onboarding.ts";

const PAIRED_ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000021";
const PAIRED_STORAGE_ID = "00000000-0000-4000-8000-000000000022";
const SSH_ENVIRONMENT_ID = "00000000-0000-4000-8000-000000000031";

const CLIENT_PRESENTATION_LAYER = Layer.succeed(
  ClientPresentation,
  ClientPresentation.of({
    metadata: {
      label: "BiBCode Test",
      deviceType: "desktop",
      os: "Test OS",
    },
    scopes: AuthStandardClientScopes,
  }),
);

function pairingHttpLayer(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: { readonly failDescriptor?: boolean },
) {
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/.well-known/bibcode/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          storageInstanceId: PAIRED_STORAGE_ID,
          protocol: { minimum: 1, maximum: 1 },
          capabilities: {
            repositoryIdentity: true,
          },
        }),
      );
    }

    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(
        Response.json({
          access_token: "bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: AuthStandardClientScopes.join(" "),
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return remoteHttpClientLayer(fetchFn);
}

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Paired environment",
          connectionId: `bearer:${PAIRED_ENVIRONMENT_ID}`,
        },
        profile: {
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Paired environment",
          connectionId: `bearer:${PAIRED_ENVIRONMENT_ID}`,
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/bibcode/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.get("scope")).toBe(AuthStandardClientScopes.join(" "));
      expect(tokenParams.get("client_label")).toBe("BiBCode Test");
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, { failDescriptor: true }),
          ),
        ),
        Effect.flip,
      );

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/bibcode/environment",
      ]);
    }),
  );

  it.effect("publishes pairing enrollment only through the normalized environment API", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      let registered: EnvironmentRegistrationInput | undefined;
      const registry = EnvironmentRegistry.of({
        registerEnvironment: (input: EnvironmentRegistrationInput) =>
          Effect.sync(() => {
            registered = input;
          }),
      } as unknown as EnvironmentRegistry["Service"]);

      const environmentId = yield* registerPairingConnection({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))),
      );

      expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
      expect(registered).toMatchObject({
        environment: {
          environmentId: PAIRED_ENVIRONMENT_ID,
          acceptedStorageInstanceId: PAIRED_STORAGE_ID,
          routes: [
            {
              _tag: "DirectHttpsRoute",
              httpsBaseUrl: "https://remote.example.test/",
              secretRef: null,
            },
          ],
        },
        sessionSecret: {
          routeId: `bearer:${PAIRED_ENVIRONMENT_ID}`,
          value: "bearer-token",
        },
      });
    }),
  );

  it.effect("rejects non-loopback HTTP before descriptor or pairing access", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "http://remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("rejects invalid pairing details before making a request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "",
        pairingCode: "",
      }).pipe(
        Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        message: "Enter a backend URL.",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          SshEnvironmentGateway,
          SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make(SSH_ENVIRONMENT_ID),
                label: "Remote development box",
                descriptor: {
                  environmentId: EnvironmentId.make(SSH_ENVIRONMENT_ID),
                  label: "Remote development box",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "0.0.0-test",
                  storageInstanceId: "00000000-0000-4000-8000-000000000032",
                  protocol: { minimum: 1, maximum: 1 },
                  capabilities: {
                    repositoryIdentity: true,
                    worktreeCatalog: false,
                    worktreeCatalogRefreshReason: false,
                    vcsStatusSummary: false,
                    activityProtocolVersion: null,
                  },
                },
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            inspect: () => Effect.die("unused"),
            exchange: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: SSH_ENVIRONMENT_ID,
          label: "Remote development box",
          connectionId: `ssh:${SSH_ENVIRONMENT_ID}`,
        },
        profile: {
          environmentId: SSH_ENVIRONMENT_ID,
          label: "Remote development box",
          connectionId: `ssh:${SSH_ENVIRONMENT_ID}`,
          target,
        },
      });
    }),
  );
});
