import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AuthAccessSnapshot, AuthClientSession } from "./auth.ts";

const decodeSession = Schema.decodeUnknownSync(Schema.toCodecJson(AuthClientSession));
const decodeSnapshot = Schema.decodeUnknownSync(Schema.toCodecJson(AuthAccessSnapshot));

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

describe("AuthAccessSnapshot across versions", () => {
  it("decodes a snapshot with and without named clients", () => {
    const snapshot = { pairingLinks: [], clientSessions: [agentSession] };
    expect(decodeSnapshot(snapshot).mcpNamedClients).toBeUndefined();
    const named = decodeSnapshot({
      ...snapshot,
      mcpNamedClients: [{ id: "nc_1", name: "builder", createdAt: "2026-11-07T00:00:00.000Z" }],
    }).mcpNamedClients;
    expect(named?.map((client) => [client.id, client.name])).toEqual([["nc_1", "builder"]]);
  });
});
