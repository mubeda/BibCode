import { AssetResource, EnvironmentId, WS_METHODS } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { fileContentRoute } from "../operations/fileContentRoute.ts";
import { FileTransferClientError } from "../operations/fileTransfers.ts";
import {
  readFileTransferSession,
  sameFileContentIdentity,
  type FileContentIdentity,
} from "../operations/fileTransferSession.ts";
import { currentSession, requestInSession } from "../rpc/client.ts";
import type { AssetByteCache, AssetReadFailure } from "./assetByteCache.ts";
import { makeAssetByteCacheOwner } from "./assetByteCacheOwner.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;
const assetKeyCodec = Schema.fromJsonString(Schema.Tuple([EnvironmentId, AssetResource]));
const encodeAssetKey = Schema.encodeSync(assetKeyCodec);
const decodeAssetKey = Schema.decodeSync(assetKeyCodec);
const resourceKeyCodec = Schema.fromJsonString(AssetResource);
const encodeResourceKey = Schema.encodeSync(resourceKeyCodec);
const decodeResourceKey = Schema.decodeSync(resourceKeyCodec);

export class InvalidAssetCollectionKeyError extends Schema.TaggedError<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

export function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    return new URL(relativeUrl, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const mintAuthorities = new WeakMap<object, FileContentIdentity>();
  const mint = Effect.fn("Assets.createHttpUrl")(function* (input: {
    readonly resource: AssetResource;
  }) {
    const registry = yield* EnvironmentRegistry;
    const supervisor = yield* EnvironmentSupervisor;
    const session = yield* currentSession();
    const carrying = yield* readFileTransferSession(registry, supervisor, session);
    if (fileContentRoute(carrying.prepared, carrying.config) !== "http")
      return yield* new FileTransferClientError({
        reason: "unavailable",
        message: "This connection must read assets through its encrypted channel.",
      });
    const result = yield* requestInSession(
      session,
      supervisor.target.environmentId,
      WS_METHODS.assetsCreateUrl,
      input,
    );
    const current = yield* readFileTransferSession(registry, supervisor, session);
    if (
      fileContentRoute(current.prepared, current.config) !== "http" ||
      !sameFileContentIdentity(carrying.identity, current.identity)
    )
      return yield* new FileTransferClientError({
        reason: "unavailable",
        message: "The asset's connection changed. Load it again.",
      });
    mintAuthorities.set(result, carrying.identity);
    return result;
  });
  const createUrl = createEnvironmentQueryAtomFamily<
    EnvironmentRegistry | R,
    E,
    Parameters<typeof mint>[0],
    Effect.Success<ReturnType<typeof mint>>,
    Effect.Error<ReturnType<typeof mint>>
  >(runtime, {
    label: "environment-data:assets:create-url",
    execute: mint,
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
  });
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) =>
        get(
          createUrl({
            environmentId,
            input: { resource },
          }),
        ),
      ),
    ).pipe(
      Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS),
      Atom.withLabel(`environment-data:assets:create-urls:${key}`),
    );
  });

  const ownerAtom = runtime
    .atom(
      makeAssetByteCacheOwner({
        urls: {
          create: (blob) => URL.createObjectURL(blob),
          revoke: (url) => URL.revokeObjectURL(url),
        },
      }),
    )
    .pipe(Atom.keepAlive);
  const viewFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom((get) =>
      Stream.unwrap(get.result(ownerAtom).pipe(Effect.map((owner) => owner.watch(environmentId)))),
    ),
  );
  const byteFamilies = new WeakMap<
    AssetByteCache,
    (key: string) => Atom.Atom<AsyncResult.AsyncResult<string, AssetReadFailure | E>>
  >();
  const byteUrl = (cache: AssetByteCache, resource: AssetResource) => {
    let family = byteFamilies.get(cache);
    if (family === undefined) {
      family = Atom.family((key: string) =>
        runtime
          .atom(
            Effect.acquireRelease(cache.acquire(decodeResourceKey(key)), (lease) =>
              Effect.sync(lease.release),
            ).pipe(Effect.map((lease) => lease.url)),
          )
          .pipe(Atom.setIdleTTL(0)),
      );
      byteFamilies.set(cache, family);
    }
    return family(encodeResourceKey(resource));
  };
  const urlFamily = Atom.family((key: string) => {
    const [environmentId, resource] = decodeAssetKey(key);
    return Atom.make((get) => {
      const view = Option.getOrNull(AsyncResult.value(get(viewFamily(environmentId))));
      if (view === null || view.route === "unavailable") return null;
      if (view.route === "in-channel")
        return Option.getOrNull(AsyncResult.value(get(byteUrl(view.cache, resource))));
      const result = Option.getOrNull(
        AsyncResult.value(get(createUrl({ environmentId, input: { resource } }))),
      );
      if (result === null) return null;
      const authority = mintAuthorities.get(result);
      // A relative token from an old HTTP host must never be sent to a retargeted host.
      return authority !== undefined && sameFileContentIdentity(authority, view.identity)
        ? resolveAssetUrl(view.httpBaseUrl, result.relativeUrl)
        : null;
    }).pipe(Atom.setIdleTTL(0));
  });
  const urlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) => get(urlFamily(encodeAssetKey([environmentId, resource])))),
    ).pipe(Atom.setIdleTTL(0));
  });

  return {
    url: (target: { readonly environmentId: EnvironmentId; readonly resource: AssetResource }) =>
      urlFamily(encodeAssetKey([target.environmentId, target.resource])),
    urls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => urlsFamily(JSON.stringify([target.environmentId, target.resources])),
    createUrl,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}
