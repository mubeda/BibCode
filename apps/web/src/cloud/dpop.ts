import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
} from "@bibcode/shared/dpop";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { importJWK, SignJWT, type JWK } from "jose";

export interface BrowserDpopKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

export class BrowserDpopError extends Data.TaggedError("BrowserDpopError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const DPOP_DATABASE_NAME = "bibcode:cloud-auth";
const DPOP_DATABASE_VERSION = 1;
const DPOP_KEY_STORE_NAME = "keys";
const DPOP_KEY_ID = "relay-dpop-proof-key";
const decodeDpopPublicJwk = Schema.decodeUnknownEffect(DpopPublicJwk);
/** How long one DPoP key storage request may stay silent before it fails. */
const DPOP_STORAGE_DEADLINE_MS = 10_000;
const DPOP_STORAGE_SILENT_MESSAGE =
  "DPoP key storage did not answer in time, so the relay request was not signed. Quit BiBCode and open it again.";

export const browserCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

function dpopError(message: string, cause?: unknown) {
  return new BrowserDpopError({ message, ...(cause === undefined ? {} : { cause }) });
}

/**
 * Settles one DPoP storage request once and fails it when IndexedDB stays
 * silent. A timeout never substitutes weaker key storage. `resume` returns
 * false once the deadline settled the request.
 */
function withDpopDeadline<A>(
  register: (
    resume: (effect: Effect.Effect<A, BrowserDpopError>) => boolean,
  ) => IDBTransaction | void,
): Effect.Effect<A, BrowserDpopError> {
  return Effect.callback<A, BrowserDpopError>((resume) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const transaction = register((effect) => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      resume(effect);
      return true;
    });
    if (settled) return;
    // @effect-diagnostics-next-line globalTimersInEffect:off
    deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        // A key write that lands later could race the next key the relay generates.
        transaction?.abort();
      } catch {
        // The transaction already committed or finished.
      }
      resume(Effect.fail(dpopError(DPOP_STORAGE_SILENT_MESSAGE)));
    }, DPOP_STORAGE_DEADLINE_MS);
  });
}

function openDpopDatabase(name = DPOP_DATABASE_NAME): Effect.Effect<IDBDatabase, BrowserDpopError> {
  return withDpopDeadline<IDBDatabase>((resume) => {
    const request = indexedDB.open(name, DPOP_DATABASE_VERSION);
    request.addEventListener("error", () =>
      resume(
        Effect.fail(dpopError("Could not open DPoP key storage.", request.error ?? undefined)),
      ),
    );
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(DPOP_KEY_STORE_NAME)) {
        request.result.createObjectStore(DPOP_KEY_STORE_NAME);
      }
    });
    request.addEventListener("success", () => {
      // An open that answers after its deadline is closed, because nobody uses it.
      if (!resume(Effect.succeed(request.result))) request.result.close();
    });
  });
}

function readStoredBrowserDpopKeyFrom(
  databaseName: string,
): Effect.Effect<BrowserDpopKey | null, BrowserDpopError> {
  return Effect.acquireUseRelease(
    openDpopDatabase(databaseName),
    (database) =>
      withDpopDeadline<BrowserDpopKey | null>((resume) => {
        const request = database
          .transaction(DPOP_KEY_STORE_NAME, "readonly")
          .objectStore(DPOP_KEY_STORE_NAME)
          .get(DPOP_KEY_ID);
        request.addEventListener("error", () =>
          resume(Effect.fail(dpopError("Could not read DPoP key.", request.error ?? undefined))),
        );
        request.addEventListener("success", () =>
          resume(Effect.succeed((request.result as BrowserDpopKey | undefined) ?? null)),
        );
      }),
    (database) => Effect.sync(() => database.close()),
  );
}

function writeStoredBrowserDpopKeyTo(
  databaseName: string,
  key: BrowserDpopKey,
): Effect.Effect<void, BrowserDpopError> {
  return Effect.acquireUseRelease(
    openDpopDatabase(databaseName),
    (database) =>
      withDpopDeadline<void>((resume) => {
        const transaction = database.transaction(DPOP_KEY_STORE_NAME, "readwrite");
        transaction.addEventListener("error", () =>
          resume(
            Effect.fail(dpopError("Could not write DPoP key.", transaction.error ?? undefined)),
          ),
        );
        transaction.addEventListener("complete", () => resume(Effect.void));
        transaction.objectStore(DPOP_KEY_STORE_NAME).put(key, DPOP_KEY_ID);
        return transaction;
      }),
    (database) => Effect.sync(() => database.close()),
  );
}

export function readStoredBrowserDpopKey(): Effect.Effect<BrowserDpopKey | null, BrowserDpopError> {
  if (typeof indexedDB === "undefined") return Effect.succeed(null);
  return readStoredBrowserDpopKeyFrom(DPOP_DATABASE_NAME);
}

export function writeStoredBrowserDpopKey(
  key: BrowserDpopKey,
): Effect.Effect<void, BrowserDpopError> {
  return typeof indexedDB === "undefined"
    ? Effect.void
    : writeStoredBrowserDpopKeyTo(DPOP_DATABASE_NAME, key);
}

export const generateBrowserDpopKey = Effect.gen(function* () {
  const generated = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]) as Promise<CryptoKeyPair>,
    catch: (cause) => dpopError("Could not generate DPoP proof key.", cause),
  });
  const privateJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.privateKey),
    catch: (cause) => dpopError("Could not export DPoP private key.", cause),
  });
  const publicJwk = yield* Effect.tryPromise({
    try: () => crypto.subtle.exportKey("jwk", generated.publicKey),
    catch: (cause) => dpopError("Could not export DPoP public key.", cause),
  }).pipe(
    Effect.flatMap((jwk) => decodeDpopPublicJwk(jwk)),
    Effect.mapError((cause) =>
      cause instanceof BrowserDpopError
        ? cause
        : dpopError("Generated DPoP public key is invalid.", cause),
    ),
  );
  const privateKey = yield* Effect.tryPromise({
    try: () => importJWK(privateJwk as JWK, "ES256", { extractable: false }) as Promise<CryptoKey>,
    catch: (cause) => dpopError("Could not import DPoP private key.", cause),
  });
  return {
    privateKey,
    publicJwk,
    thumbprint: computeDpopJwkThumbprint(publicJwk),
  };
});

export function createBrowserDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
  readonly proofKey: BrowserDpopKey;
}): Effect.Effect<
  { readonly proof: string; readonly thumbprint: string },
  BrowserDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    const normalizedUrl = yield* Effect.try({
      try: () => new URL(input.url),
      catch: (cause) => dpopError("Could not normalize DPoP proof URL.", cause),
    });
    normalizedUrl.search = "";
    normalizedUrl.hash = "";
    const jti = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.mapError((cause) => dpopError("Could not generate DPoP proof identifier.", cause)),
    );
    const proof = yield* Effect.tryPromise({
      try: () =>
        new SignJWT({
          htm: input.method.toUpperCase(),
          htu: normalizedUrl.toString(),
          jti,
          ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
        })
          .setProtectedHeader({
            typ: "dpop+jwt",
            alg: "ES256",
            jwk: input.proofKey.publicJwk,
          })
          .setIssuedAt()
          .sign(input.proofKey.privateKey),
      catch: (cause) => dpopError("Could not sign DPoP proof.", cause),
    });
    return { proof, thumbprint: input.proofKey.thumbprint };
  });
}
