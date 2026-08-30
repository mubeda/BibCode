// @effect-diagnostics nodeBuiltinImport:off - This gate inspects checked-in server source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

/**
 * The WebSocket route caps are defense in depth behind equal-or-tighter
 * application-layer bounds (the Noise record decoder rejects oversized
 * ciphertext, and tungstenite's defaults match the plain-route values), so
 * deleting them produces no externally observable behavior change — a
 * black-box test cannot detect the mutation. What they do bound is how much
 * a peer can make the WebSocket layer buffer before the application sees the
 * message at all, so their presence and values are pinned structurally here.
 */
describe("websocket transport caps contract", () => {
  const http = NodeFS.readFileSync(
    NodePath.join(REPOSITORY_ROOT, "apps/server/src/http.rs"),
    "utf8",
  );

  it("pins the plain /ws frame and message caps to their guarded values", () => {
    expect(http).toContain("const MAX_PLAIN_WEBSOCKET_MESSAGE_BYTES: usize = 64 * 1024 * 1024;");
    expect(http).toContain("const MAX_PLAIN_WEBSOCKET_FRAME_BYTES: usize = 16 * 1024 * 1024;");
    const plainSites = http.match(
      /\.max_frame_size\(MAX_PLAIN_WEBSOCKET_FRAME_BYTES\)\s*\.max_message_size\(MAX_PLAIN_WEBSOCKET_MESSAGE_BYTES\)/g,
    );
    // Both the unsafe-no-auth and the authenticated upgrade must carry them.
    expect(plainSites?.length).toBe(2);
  });

  it("pins the /ws-e2ee frame and message caps to one ciphertext record", () => {
    const e2eeSites = http.match(
      /\.max_frame_size\(MAX_E2EE_CIPHERTEXT_BYTES\)\s*\.max_message_size\(MAX_E2EE_CIPHERTEXT_BYTES\)/g,
    );
    expect(e2eeSites?.length).toBe(1);
    const e2ee = NodeFS.readFileSync(
      NodePath.join(REPOSITORY_ROOT, "apps/server/src/rpc/e2ee.rs"),
      "utf8",
    );
    expect(e2ee).toContain("pub(crate) const MAX_E2EE_CIPHERTEXT_BYTES: usize = 65_535;");
  });
});
