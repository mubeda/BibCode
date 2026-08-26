import { UpdateMaintenanceActiveError, WS_METHODS } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import { WsRpcClientGroup } from "./protocol.ts";

describe("WebSocket RPC client protocol", () => {
  it.each([WS_METHODS.previewRefresh, WS_METHODS.gitRunStackedAction])(
    "decodes the server-wide update admission error for %s",
    (method) => {
      const rpc = WsRpcClientGroup.requests.get(method);
      expect(rpc).toBeDefined();
      expect(
        [...(rpc?.middlewares ?? [])].some(
          (middleware) => middleware.error === UpdateMaintenanceActiveError,
        ),
      ).toBe(true);
    },
  );
});
