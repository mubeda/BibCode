import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

const MEBIBYTE = 1024 * 1024;

const formatMebibytes = (bytes: number): string => {
  const mebibytes = bytes / MEBIBYTE;
  return `${Number.isInteger(mebibytes) ? mebibytes.toFixed(0) : mebibytes.toFixed(1)} MiB`;
};

/**
 * The server could not send a response because it exceeds the connection's
 * message limit. Only the request that produced it fails; the connection
 * stays open. Every RPC method can end with it.
 */
export class RpcResponseTooLargeError extends Schema.TaggedError<RpcResponseTooLargeError>()(
  "RpcResponseTooLargeError",
  {
    method: Schema.String,
    bytes: NonNegativeInt,
    limitBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `This result is too large to send (${formatMebibytes(this.bytes)}; limit ${formatMebibytes(this.limitBytes)}).`;
  }
}
