import { describe, expect, it } from "vite-plus/test";
import { requireInlineProbeOwner } from "./chat-inline-receiver.ts";
const owner = {
  linux: true,
  ci: true,
  privateNet: true,
  netMatches: true,
  pidMatches: true,
  userMatches: true,
  pid1NetMatches: true,
  pid1PidMatches: true,
  pid1UserMatches: true,
  networkPrepared: true,
  browserOnline: true,
  contained: true,
};
describe("inline transport fixture admission", () => {
  it("admits the complete closed owner proof for the guarded live producer", () => {
    expect(() => requireInlineProbeOwner(owner)).not.toThrow();
  });
  it.each(Object.keys(owner))(
    "refuses the missing %s ownership proof before any listener admission",
    (key) => {
      expect(() => requireInlineProbeOwner({ ...owner, [key]: false })).toThrow(
        "Inline probe owner refused.",
      );
    },
  );
  it("refuses extra or incomplete ownership proof", () => {
    expect(() => requireInlineProbeOwner({ ...owner, rawNamespace: "private" })).toThrow();
    expect(() => requireInlineProbeOwner({ linux: true })).toThrow();
  });
});
