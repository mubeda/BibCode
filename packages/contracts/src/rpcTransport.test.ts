import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RpcResponseTooLargeError } from "./rpcTransport.ts";

const encodeRpcResponseTooLargeError = Schema.encodeSync(RpcResponseTooLargeError);

describe("RpcResponseTooLargeError", () => {
  it("says how large the result was and what the limit is", () => {
    const error = new RpcResponseTooLargeError({
      method: "gitManager.getCommits",
      bytes: 70_000_000,
      limitBytes: 67_108_864,
    });
    expect(error.message).toBe("This result is too large to send (66.8 MiB; limit 64 MiB).");
  });

  it("encodes to the wire shape the Rust server sends", () => {
    const encoded = encodeRpcResponseTooLargeError(
      new RpcResponseTooLargeError({ method: "m", bytes: 1, limitBytes: 2 }),
    );
    expect(encoded).toEqual({
      _tag: "RpcResponseTooLargeError",
      method: "m",
      bytes: 1,
      limitBytes: 2,
    });
  });
});
