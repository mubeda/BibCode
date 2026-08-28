import type { E2eeAuthenticatedMessage } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";
import { vi } from "vite-plus/test";

import { RecordAssembler, splitIntoRecords } from "./frame.ts";
import { createNkResponder, derivePublicKey, type NkTransport } from "./noise.ts";
import { e2eeFailureOf, E2eeProtocolError, makeE2eeSocket } from "./socket.ts";

const encryptProbe = vi.hoisted(() => ({ calls: 0 }));

vi.mock("./noise.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./noise.ts")>();
  return {
    ...actual,
    createNkInitiator(options: Parameters<typeof actual.createNkInitiator>[0]) {
      const initiator = actual.createNkInitiator(options);
      return {
        ...initiator,
        split() {
          const transport = initiator.split();
          return {
            ...transport,
            send: {
              encryptWithAd(ad: Uint8Array, plaintext: Uint8Array) {
                encryptProbe.calls += 1;
                return transport.send.encryptWithAd(ad, plaintext);
              },
              decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array) {
                return transport.send.decryptWithAd(ad, ciphertext);
              },
            },
          };
        },
      };
    },
  };
});

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const makeScriptedInnerSocket = (
  onFrame: (
    frame: Uint8Array,
    emit: (frame: Uint8Array) => void,
    close: (code?: number) => void,
  ) => void,
  beforeWrite?: (frame: Uint8Array) => Effect.Effect<void>,
): Socket.Socket => {
  let deliver: ((frame: Uint8Array) => void) | null = null;
  let finish: ((code?: number) => void) | null = null;
  const pending: Array<Uint8Array> = [];
  let closed: { code?: number } | null = null;
  const emit = (frame: Uint8Array): void => {
    if (deliver === null) pending.push(frame);
    else deliver(frame);
  };
  const close = (code?: number): void => {
    queueMicrotask(() => {
      closed = code === undefined ? {} : { code };
      if (finish !== null) finish(code);
    });
  };

  const runRaw = <A, E, R>(
    handler: (data: string | Uint8Array) => Effect.Effect<A, E, R> | void,
    options?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    Effect.scopedWith((scope) =>
      Effect.gen(function* () {
        const fiberSet = yield* FiberSet.make<unknown, Socket.SocketError | E>().pipe(
          Scope.provide(scope),
        );
        const run = yield* FiberSet.runtime(fiberSet)<R>();
        deliver = (frame) => {
          const result = handler(frame);
          if (Effect.isEffect(result)) run(result);
        };
        finish = (code) =>
          Deferred.doneUnsafe(
            fiberSet.deferred,
            code === undefined || code === 1000
              ? Effect.void
              : Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketCloseError({ code, closeReason: "" }),
                  }),
                ),
          );
        for (const frame of pending.splice(0)) deliver(frame);
        const closedSnapshot = closed;
        if (closedSnapshot !== null) finish(closedSnapshot.code);
        else if (options?.onOpen) yield* options.onOpen;
        return yield* FiberSet.join(fiberSet);
      }),
    );

  return Socket.make({
    runRaw,
    writer: Effect.succeed((chunk: Uint8Array | string | Socket.CloseEvent) =>
      Effect.suspend(() => {
        if (typeof chunk === "string" || chunk instanceof Uint8Array) {
          const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
          return Effect.andThen(
            beforeWrite?.(bytes) ?? Effect.void,
            Effect.sync(() => onFrame(bytes, emit, close)),
          );
        } else {
          close();
          return Effect.void;
        }
      }),
    ),
  });
};

const findE2eeCause = (exit: Exit.Exit<unknown, unknown>): E2eeProtocolError | null => {
  if (exit._tag !== "Failure") return null;
  const failure = Cause.findErrorOption(exit.cause);
  return Option.isSome(failure) ? e2eeFailureOf(failure.value) : null;
};

const responderScript = (options?: { failAuth?: boolean; messageBPayload?: Uint8Array }) => {
  const staticPrivate = crypto.getRandomValues(new Uint8Array(32));
  const hostKey = derivePublicKey(staticPrivate);
  const responder = createNkResponder({ staticPrivateKey: staticPrivate });
  const assembler = new RecordAssembler();
  let transport: NkTransport | null = null;
  const received: Array<string> = [];
  const currentTransport = (): NkTransport => {
    if (transport === null) throw new Error("transport is not ready");
    return transport;
  };
  const script = (
    frame: Uint8Array,
    emit: (frame: Uint8Array) => void,
    close: (code?: number) => void,
  ): void => {
    if (transport === null) {
      responder.readMessageA(frame);
      const messageB = responder.writeMessageB(options?.messageBPayload ?? new Uint8Array(0));
      transport = responder.split();
      emit(messageB);
      return;
    }
    const record = transport.receive.decryptWithAd(new Uint8Array(0), frame);
    const message = assembler.push(record);
    if (message === null) return;
    const text = new TextDecoder().decode(message);
    received.push(text);
    const reply = (body: object) => {
      for (const outRecord of splitIntoRecords(new TextEncoder().encode(encodeJson(body)))) {
        emit(currentTransport().send.encryptWithAd(new Uint8Array(0), outRecord));
      }
    };
    const decoded = decodeJson(text);
    const parsed = decoded as { type?: string; pairing?: string; bearer?: string };
    if (parsed.type === "e2ee_auth") {
      if (options?.failAuth) {
        reply({ type: "e2ee_error", code: "unauthorized" });
        close();
      } else if (parsed.pairing !== undefined) {
        reply({
          type: "e2ee_authenticated",
          credential: `minted-for-${parsed.pairing}`,
          environmentId: "env-1",
          storageInstanceId: "3f2f6a52-6f5f-4f4e-9d38-0a1e2ac21d11",
        });
      } else {
        reply({ type: "e2ee_authenticated" });
      }
      return;
    }
    reply({ echoed: text.length });
  };
  return { hostKey, script, received };
};

describe("makeE2eeSocket", () => {
  it.live("handshakes, bootstraps in-channel, then delivers decrypted strings", () =>
    Effect.gen(function* () {
      const { hostKey, script, received } = responderScript();
      const authenticated: Array<E2eeAuthenticatedMessage> = [];
      const socket = makeE2eeSocket(makeScriptedInnerSocket(script), {
        hostKey: Buffer.from(hostKey).toString("base64url"),
        auth: { kind: "pairing", token: "one-time-1" },
        onAuthenticated: (message) => {
          authenticated.push(message);
        },
      });
      const delivered: Array<string> = [];
      const opened = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const write = yield* socket.writer;
            const queuedWrite = yield* Effect.forkChild(write(encodeJson({ hello: true })), {
              startImmediately: true,
            });
            yield* Effect.forkChild(
              socket.runString(
                (text) => {
                  delivered.push(text);
                },
                { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) },
              ),
            );
            yield* Deferred.await(opened);
            expect(authenticated).toHaveLength(1);
            yield* Fiber.join(queuedWrite);
            yield* Effect.sleep("50 millis");
          }),
        ),
      );
      yield* Effect.sleep("200 millis");
      yield* Fiber.interrupt(fiber);
      expect(received[0]).toBe(encodeJson({ type: "e2ee_auth", pairing: "one-time-1" }));
      expect(received[1]).toBe(encodeJson({ hello: true }));
      expect(delivered).toEqual([encodeJson({ echoed: received[1]?.length })]);
      expect(authenticated[0]?.credential).toBe("minted-for-one-time-1");
      expect(authenticated[0]?.environmentId).toBe("env-1");
    }),
  );

  it.live("bearer form sends the stored credential", () =>
    Effect.gen(function* () {
      const { hostKey, script, received } = responderScript();
      const socket = makeE2eeSocket(makeScriptedInnerSocket(script), {
        hostKey: Buffer.from(hostKey).toString("base64url"),
        auth: { kind: "bearer", credential: "stored-1" },
      });
      const opened = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        socket.runString(() => {}, {
          onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
        }),
      );
      yield* Deferred.await(opened);
      yield* Fiber.interrupt(fiber);
      expect(received[0]).toBe(encodeJson({ type: "e2ee_auth", bearer: "stored-1" }));
    }),
  );

  it.live("maps a 4403 close to host-identity-mismatch", () =>
    Effect.gen(function* () {
      const script = (
        _frame: Uint8Array,
        _emit: (frame: Uint8Array) => void,
        close: (code?: number) => void,
      ): void => close(4403);
      const socket = makeE2eeSocket(makeScriptedInnerSocket(script), {
        hostKey: Buffer.from(derivePublicKey(crypto.getRandomValues(new Uint8Array(32)))).toString(
          "base64url",
        ),
        auth: { kind: "pairing", token: "t" },
      });
      const exit = yield* socket.runString(() => {}).pipe(Effect.exit);
      expect(findE2eeCause(exit)?.reason).toBe("host-identity-mismatch");
    }),
  );

  it.live("fails a write latched behind a rejected handshake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const script = (
          _frame: Uint8Array,
          _emit: (frame: Uint8Array) => void,
          close: (code?: number) => void,
        ): void => close(4403);
        const socket = makeE2eeSocket(makeScriptedInnerSocket(script), {
          hostKey: Buffer.from(
            derivePublicKey(crypto.getRandomValues(new Uint8Array(32))),
          ).toString("base64url"),
          auth: { kind: "pairing", token: "t" },
        });
        const write = yield* socket.writer;
        const writeFiber = yield* Effect.forkChild(write("queued").pipe(Effect.exit), {
          startImmediately: true,
        });
        const runExit = yield* socket.runString(() => {}).pipe(Effect.exit);
        const writeExit = yield* Fiber.join(writeFiber);
        expect(findE2eeCause(runExit)?.reason).toBe("host-identity-mismatch");
        expect(findE2eeCause(writeExit)?.reason).toBe("host-identity-mismatch");
      }),
    ),
  );

  it.live("maps message-B AEAD failure to host-identity-mismatch", () =>
    Effect.gen(function* () {
      const pinnedKey = derivePublicKey(crypto.getRandomValues(new Uint8Array(32)));
      const script = (_frame: Uint8Array, emit: (frame: Uint8Array) => void): void => {
        const forged = crypto.getRandomValues(new Uint8Array(48));
        emit(forged);
      };
      const socket = makeE2eeSocket(makeScriptedInnerSocket(script), {
        hostKey: Buffer.from(pinnedKey).toString("base64url"),
        auth: { kind: "pairing", token: "t" },
      });
      const exit = yield* socket.runString(() => {}).pipe(Effect.exit);
      expect(findE2eeCause(exit)?.reason).toBe("host-identity-mismatch");
    }),
  );

  it.live("rejects a non-empty message-B payload as a protocol violation", () =>
    Effect.gen(function* () {
      const { hostKey, script } = responderScript({ messageBPayload: Uint8Array.of(1) });
      const socket = makeE2eeSocket(makeScriptedInnerSocket(script), {
        hostKey: Buffer.from(hostKey).toString("base64url"),
        auth: { kind: "pairing", token: "t" },
      });
      const exit = yield* socket.runString(() => {}).pipe(Effect.exit);
      expect(findE2eeCause(exit)?.reason).toBe("protocol");
    }),
  );

  it.live("fails with unauthorized when the server rejects the credential", () =>
    Effect.gen(function* () {
      const { hostKey, script } = responderScript({ failAuth: true });
      const socket = makeE2eeSocket(makeScriptedInnerSocket(script), {
        hostKey: Buffer.from(hostKey).toString("base64url"),
        auth: { kind: "pairing", token: "expired" },
      });
      const exit = yield* socket.runString(() => {}).pipe(Effect.exit);
      expect(findE2eeCause(exit)?.reason).toBe("unauthorized");
    }),
  );

  it.live("times out a stalled handshake", () =>
    Effect.gen(function* () {
      const socket = makeE2eeSocket(
        makeScriptedInnerSocket(() => {}),
        {
          hostKey: Buffer.from(
            derivePublicKey(crypto.getRandomValues(new Uint8Array(32))),
          ).toString("base64url"),
          auth: { kind: "bearer", credential: "t" },
          handshakeTimeoutMs: 100,
        },
      );
      const exit = yield* socket.runString(() => {}).pipe(Effect.exit);
      expect(findE2eeCause(exit)?.reason).toBe("timeout");
    }),
  );

  it.live("fragments large writes and reassembles replies", () =>
    Effect.gen(function* () {
      const { hostKey, script, received } = responderScript();
      const socket = makeE2eeSocket(makeScriptedInnerSocket(script), {
        hostKey: Buffer.from(hostKey).toString("base64url"),
        auth: { kind: "bearer", credential: "stored-1" },
      });
      const large = encodeJson({ blob: "x".repeat(200_000) });
      const delivered: Array<string> = [];
      const opened = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const write = yield* socket.writer;
            yield* Effect.forkChild(
              socket.runString(
                (text) => {
                  delivered.push(text);
                },
                { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) },
              ),
            );
            yield* Deferred.await(opened);
            yield* write(large);
            yield* Effect.sleep("100 millis");
          }),
        ),
      );
      yield* Effect.sleep("300 millis");
      yield* Fiber.interrupt(fiber);
      expect(received[1]).toBe(large);
      expect(delivered).toEqual([encodeJson({ echoed: large.length })]);
    }),
  );

  it.live("does not encrypt later records while the first write is backpressured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hostKey, script } = responderScript();
        const firstWriteStarted = yield* Deferred.make<void>();
        const releaseFirstWrite = yield* Deferred.make<void>();
        let blockNextWrite = false;
        const inner = makeScriptedInnerSocket(script, () => {
          if (!blockNextWrite) return Effect.void;
          blockNextWrite = false;
          return Deferred.succeed(firstWriteStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstWrite)),
          );
        });
        const socket = makeE2eeSocket(inner, {
          hostKey: Buffer.from(hostKey).toString("base64url"),
          auth: { kind: "bearer", credential: "stored-1" },
        });
        const opened = yield* Deferred.make<void>();
        const runFiber = yield* Effect.forkChild(
          socket.runString(() => {}, {
            onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
          }),
        );
        yield* Deferred.await(opened);

        const write = yield* socket.writer;
        encryptProbe.calls = 0;
        blockNextWrite = true;
        const writeFiber = yield* Effect.forkChild(
          write(encodeJson({ blob: "x".repeat(200_000) })),
          {
            startImmediately: true,
          },
        );
        yield* Deferred.await(firstWriteStarted);
        expect(encryptProbe.calls).toBe(1);

        yield* Deferred.succeed(releaseFirstWrite, undefined);
        yield* Fiber.join(writeFiber);
        yield* Fiber.interrupt(runFiber);
      }),
    ),
  );
});
