// @effect-diagnostics nodeBuiltinImport:off - This gate inspects checked-in Rust source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

describe("remote transport hardening", () => {
  it("caps E2EE WebSocket frames and messages before application buffering", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(REPOSITORY_ROOT, "apps/server/src/http.rs"),
      "utf8",
    );
    const routeStart = source.indexOf("async fn websocket_e2ee");
    const routeEnd = source.indexOf("pub(crate) fn spawn_session_expiration_guard", routeStart);
    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const e2eeRoute = source.slice(routeStart, routeEnd);

    expect(e2eeRoute).toContain(".max_frame_size(MAX_E2EE_CIPHERTEXT_BYTES)");
    expect(e2eeRoute).toContain(".max_message_size(MAX_E2EE_CIPHERTEXT_BYTES)");
  });
});
