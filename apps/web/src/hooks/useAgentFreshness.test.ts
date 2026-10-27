import { afterEach, describe, expect, it } from "vite-plus/test";

import { AGENT_STATUS_STALE_AFTER_MS, isAgentEvidenceStale } from "../components/Sidebar.logic";
import { agentEvidenceAt, resetAgentEvidenceStampsForTests } from "./useAgentFreshness";

// Evidence age is measured on this client's clock from its first sight of each piece of
// evidence, less the server's own age of it then (#187).

const CLIENT_NOW = Date.parse("2026-10-27T12:00:00.000Z");
const MINUTE = 60_000;

afterEach(() => {
  resetAgentEvidenceStampsForTests();
});

describe("agentEvidenceAt", () => {
  it("is immune to server clock skew: only the server's age of the evidence counts", () => {
    // The server's clock runs two hours ahead; its evidence is 5 minutes old by that clock.
    const serverEvidence = "2026-10-27T13:55:00.000Z";
    const evidenceAt = agentEvidenceAt("row", serverEvidence, 5 * MINUTE, true, CLIENT_NOW);
    expect(evidenceAt).toBe(CLIENT_NOW - 5 * MINUTE);
    expect(isAgentEvidenceStale(evidenceAt, CLIENT_NOW + 20 * MINUTE)).toBe(false);
    expect(isAgentEvidenceStale(evidenceAt, CLIENT_NOW + 26 * MINUTE)).toBe(true);
  });

  it("does not grant 30 fresh minutes on launch: old evidence is stale at first sight", () => {
    const evidenceAt = agentEvidenceAt("row", "e1", 40 * MINUTE, true, CLIENT_NOW);
    expect(isAgentEvidenceStale(evidenceAt, CLIENT_NOW)).toBe(true);
  });

  it("keeps the first sight of repeated evidence and restamps new evidence", () => {
    const first = agentEvidenceAt("row", "e1", 0, true, CLIENT_NOW);
    // A later snapshot repeats the same evidence with a larger age: no refresh.
    expect(agentEvidenceAt("row", "e1", 10 * MINUTE, true, CLIENT_NOW + 10 * MINUTE)).toBe(first);
    expect(
      isAgentEvidenceStale(
        agentEvidenceAt("row", "e1", 31 * MINUTE, true, CLIENT_NOW + 31 * MINUTE),
        CLIENT_NOW + 31 * MINUTE,
      ),
    ).toBe(true);
    // New provider progress restamps.
    const next = agentEvidenceAt("row", "e2", 0, true, CLIENT_NOW + 31 * MINUTE);
    expect(next).toBe(CLIENT_NOW + 31 * MINUTE);
    expect(isAgentEvidenceStale(next, CLIENT_NOW + 31 * MINUTE)).toBe(false);
  });

  it("never stamps from a disconnected environment's cached snapshot", () => {
    expect(agentEvidenceAt("row", "cached", 0, false, CLIENT_NOW)).toBeNull();
    // Once connected, the live snapshot's age is used.
    expect(agentEvidenceAt("row", "cached", 45 * MINUTE, true, CLIENT_NOW)).toBe(
      CLIENT_NOW - 45 * MINUTE,
    );
  });

  it("has no evidence without a timestamp", () => {
    expect(agentEvidenceAt("row", undefined, undefined, true, CLIENT_NOW)).toBeNull();
    expect(isAgentEvidenceStale(null, CLIENT_NOW + AGENT_STATUS_STALE_AFTER_MS * 2)).toBe(false);
  });
});
