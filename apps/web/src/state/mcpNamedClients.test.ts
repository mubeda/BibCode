import type { AuthAccessSnapshot } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { idleNamedClients } from "./mcpNamedClients";

describe("idleNamedClients", () => {
  it("lists the named clients no live session is a run of", () => {
    const named = (id: string) => ({ id, name: id, createdAt: "2026-11-07T00:00:00.000Z" });
    const snapshot = {
      pairingLinks: [],
      clientSessions: [{ mcpNamedClient: { id: "nc_live", name: "live" } }, {}],
      mcpNamedClients: [named("nc_live"), named("nc_idle")],
    } as unknown as AuthAccessSnapshot;
    expect(idleNamedClients(snapshot).map((client) => client.id)).toEqual(["nc_idle"]);
  });

  it("is empty for a server that predates named clients, or with none", () => {
    expect(idleNamedClients(undefined)).toEqual([]);
    expect(
      idleNamedClients({ pairingLinks: [], clientSessions: [] } as unknown as AuthAccessSnapshot),
    ).toEqual([]);
  });
});
