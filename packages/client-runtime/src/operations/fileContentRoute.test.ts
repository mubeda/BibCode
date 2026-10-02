import { ExecutionEnvironmentDescriptor, type ServerConfig } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type { PreparedConnection } from "../connection/model.ts";
import { fileContentRoute } from "./fileContentRoute.ts";

const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const descriptor = (capabilities: object) =>
  decodeEnvironmentDescriptor({
    environmentId: "host",
    label: "Host",
    serverVersion: "test",
    platform: { os: "linux", arch: "x64" },
    capabilities,
  });

describe("file content routing", () => {
  it.each([
    { pinned: false, capable: false, expected: "http" },
    { pinned: false, capable: true, expected: "http" },
    { pinned: true, capable: false, expected: "unavailable" },
    { pinned: true, capable: true, expected: "in-channel" },
  ])(
    "uses the carrying capability for $pinned / $capable regardless of scheme",
    ({ pinned, capable, expected }) => {
      for (const scheme of ["http", "https"]) {
        const prepared = {
          e2ee: pinned ? { hostKey: "pinned-key", auth: { type: "bearer", bearer: "test" } } : null,
          httpBaseUrl: `${scheme}://host.invalid`,
          descriptor: descriptor({ inChannelTransfers: !capable }),
        } as PreparedConnection;
        const config = { environment: descriptor({ inChannelTransfers: capable }) } as ServerConfig;
        expect(fileContentRoute(prepared, config)).toBe(expected);
      }
    },
  );

  it("refuses a pinned older server whose capability is omitted", () => {
    const prepared = { e2ee: { hostKey: "pin" } } as PreparedConnection;
    expect(fileContentRoute(prepared, { environment: descriptor({}) } as ServerConfig)).toBe(
      "unavailable",
    );
  });
});
