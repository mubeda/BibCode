import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Socket from "effect/unstable/socket/Socket";

import { makeChunkedSocket } from "./chunkedSocket.ts";

const encoder = new TextEncoder();
const record = (flag: number, text: string) => {
  const bytes = encoder.encode(text);
  const out = new Uint8Array(1 + bytes.length);
  out[0] = flag;
  out.set(bytes, 1);
  return out;
};

/** A socket that delivers the given frames once run, then stays open. */
const scriptedSocket = (frames: ReadonlyArray<string | Uint8Array>): Socket.Socket =>
  Socket.make({
    runRaw: (handler) =>
      Effect.gen(function* () {
        for (const frame of frames) {
          const result = handler(frame);
          if (Effect.isEffect(result)) yield* result;
        }
        return yield* Effect.never;
      }),
    writer: Effect.succeed(() => Effect.void),
  });

const collect = (socket: Socket.Socket, count: number) =>
  Effect.gen(function* () {
    const received: Array<string | Uint8Array> = [];
    const fiber = yield* Effect.forkChild(
      socket.runRaw((data) => {
        received.push(data);
      }),
    );
    for (let attempt = 0; attempt < 100 && received.length < count; attempt += 1) {
      yield* Effect.yieldNow;
    }
    yield* Fiber.interrupt(fiber);
    return received;
  });

describe("makeChunkedSocket", () => {
  it.effect("reassembles records and passes control records through in order", () =>
    Effect.gen(function* () {
      const socket = makeChunkedSocket(
        scriptedSocket([
          "whole",
          record(0x01, "par"),
          record(0x02, "control"),
          record(0x00, "tial"),
        ]),
        () => true,
      );
      expect(yield* collect(socket, 3)).toEqual(["whole", "control", "partial"]);
    }),
  );

  it.effect("passes binary frames through unchanged without the subprotocol", () =>
    Effect.gen(function* () {
      const frame = record(0x00, "legacy");
      const socket = makeChunkedSocket(scriptedSocket([frame]), () => false);
      expect(yield* collect(socket, 1)).toEqual([frame]);
    }),
  );

  it.effect("fails the socket on a malformed record", () =>
    Effect.gen(function* () {
      const socket = makeChunkedSocket(scriptedSocket([Uint8Array.of(0x07, 0x20)]), () => true);
      const error = yield* Effect.flip(socket.runRaw(() => undefined));
      expect(Socket.isSocketError(error)).toBe(true);
    }),
  );
});
