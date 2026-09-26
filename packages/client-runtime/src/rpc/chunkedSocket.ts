import * as Effect from "effect/Effect";
import * as Socket from "effect/unstable/socket/Socket";

import { RecordAssembler } from "../e2ee/frame.ts";

/** Subprotocol a plain `/ws` client offers to receive large messages as records. */
export const CHUNKED_RPC_SUBPROTOCOL = "bibcode.rpc.chunked.v1";

const decoder = new TextDecoder();

/**
 * Reassembles plain `/ws` records when the server selected
 * {@link CHUNKED_RPC_SUBPROTOCOL}. Text frames are whole messages; binary
 * frames are records (`0x00` final, `0x01` continuation, `0x02` stand-alone
 * control). Without the subprotocol every frame passes through unchanged,
 * which is today's framing. `negotiated` is read at the first frame, after the
 * socket opened.
 */
export const makeChunkedSocket = (inner: Socket.Socket, negotiated: () => boolean): Socket.Socket =>
  Socket.make({
    runRaw: <A, E, R>(
      handler: (data: string | Uint8Array) => Effect.Effect<A, E, R> | void,
      options?: { readonly onOpen?: Effect.Effect<void> | undefined },
    ): Effect.Effect<void, Socket.SocketError | E, R> =>
      Effect.suspend(() => {
        const assembler = new RecordAssembler(undefined, { allowControlRecords: true });
        let chunked: boolean | null = null;
        return inner.runRaw<A, E | Socket.SocketError, R>((data) => {
          chunked ??= negotiated();
          if (!chunked || typeof data === "string") return handler(data);
          const bytes =
            data instanceof Uint8Array ? data : new Uint8Array(data as unknown as ArrayBuffer);
          let message: Uint8Array | null;
          try {
            message = assembler.push(bytes);
          } catch (cause) {
            return Effect.fail(
              new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) }),
            );
          }
          return message === null ? undefined : handler(decoder.decode(message));
        }, options);
      }),
    writer: inner.writer,
  });
