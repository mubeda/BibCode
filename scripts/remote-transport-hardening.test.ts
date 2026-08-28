// @effect-diagnostics nodeBuiltinImport:off - This gate inspects checked-in Rust source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

describe("remote transport hardening", () => {
  it("accounts for authenticated plain sockets only after upgrade completion", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(REPOSITORY_ROOT, "apps/server/src/http.rs"),
      "utf8",
    );
    const handlerStart = source.indexOf("async fn websocket(");
    const handlerEnd = source.indexOf("async fn websocket_e2ee", handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    const authenticatedStart = handler.indexOf("Ok(principal) => {");
    const upgradeStart = handler.indexOf(".on_upgrade(move |socket| async move {");
    const upgradeEnd = handler.indexOf(".into_response()", upgradeStart);
    expect(authenticatedStart).toBeGreaterThanOrEqual(0);
    expect(upgradeStart).toBeGreaterThan(authenticatedStart);
    expect(upgradeEnd).toBeGreaterThan(upgradeStart);

    const beforeUpgrade = handler.slice(authenticatedStart, upgradeStart);
    const upgradeBody = handler.slice(upgradeStart, upgradeEnd);
    expect(beforeUpgrade).not.toContain(".mark_connected(");
    expect(upgradeBody).toContain(".mark_connected(");
    expect(upgradeBody).toContain(".mark_disconnected(");
  });

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
