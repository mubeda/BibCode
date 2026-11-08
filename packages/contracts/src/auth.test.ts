import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AuthClientSession } from "./auth.ts";

const decodeSession = Schema.decodeUnknownSync(Schema.toCodecJson(AuthClientSession));

const agentSession = {
  sessionId: "s1",
  subject: "mcp-client",
  scopes: ["orchestration:read"],
  method: "bearer-access-token",
  client: { label: "MCP · builder", deviceType: "desktop" },
  issuedAt: "2026-11-07T00:00:00.000Z",
  expiresAt: "2026-11-08T00:00:00.000Z",
  lastConnectedAt: null,
  connected: true,
  current: false,
  mcpAccess: "read-only",
};

describe("AuthClientSession across versions", () => {
  it("decodes an agent session with and without a named client", () => {
    expect(decodeSession(agentSession).mcpNamedClient).toBeUndefined();
    expect(
      decodeSession({ ...agentSession, mcpNamedClient: { id: "nc_1", name: "builder" } })
        .mcpNamedClient,
    ).toEqual({ id: "nc_1", name: "builder" });
  });
});
